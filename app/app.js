// 레퍼런스 — 화면 동작
// 검색·필터는 서버에 다시 묻지 않고, 한 번 받아온 목록에서 바로 거릅니다(입력하는 즉시 결과가 바뀜).

import { api, $, esc, toast, choseong, resizeImage, openSheet, closeSheet, sheetBody, setBusy, fmtDate, ICON } from './common.js';

const state = {
  items: [],
  artists: [],
  loggedIn: false,
  loaded: false,
  q: '',
  artist: '',
  cat: '', // '' = 전체
  tags: new Set(),
  sort: 'new',
  mode: localGet('viewMode') || 'grid',
  artistQ: '',
  stats: null, // AI 사용량 (첫 화면 게임 카드)
  todo: [], // 가볼 곳
  wish: [], // 보고 싶은 전시
  venues: {}, // 찾아 둔 전시관 정보 (이름 → 정보)
  todoEditing: false,
};

// 분류 키맵: 전시관 · 영화 · 그 외 순서. 키보드 1·2·3 (전체 0)
const CATS = [['exhibition', '전시관'], ['movie', '영화'], ['etc', '그 외']];
const catLabel = (c) => (CATS.find(([k]) => k === c) || CATS[2])[1];
// 분류마다 "어디서 봤는지" 칸 이름: 전시관 이름 · 본 곳 · 장소
const PLACE = {
  exhibition: ['전시관 이름', '예) 리움미술관, 국립현대미술관 서울'],
  movie: ['본 곳', '예) CGV 용산, 넷플릭스'],
  etc: ['장소', '예) 을지로 골목, 성수동 카페'],
};

const SORTS = { new: '최신순', old: '오래된순', title: '제목순', artist: '작가순' };

/* ─────────────── 시작 ─────────────── */

init();

async function init() {
  bindStatic();
  renderSkeleton();
  const [session] = await Promise.all([api('/api/session').catch(() => ({})), loadAll(), loadStats()]);
  state.loggedIn = !!session.loggedIn;
  state.open = !!session.open;
  renderAuth();
  route();
}

async function loadStats() {
  try {
    state.stats = await api('/api/stats');
  } catch { /* 없으면 카드에 '모름'으로 */ }
  renderHero();
}

async function loadAll() {
  try {
    const [a, b, c, w, v] = await Promise.all([api('/api/items'), api('/api/artists'), api('/api/todo').catch(() => ({ todo: [] })),
      api('/api/wish').catch(() => ({ wish: [] })), api('/api/venues').catch(() => ({ venues: [] }))]);
    state.items = a.items;
    state.artists = b.artists;
    state.todo = c.todo || [];
    state.wish = w.wish || [];
    state.venues = Object.fromEntries((v.venues || []).map((x) => [x.name, x]));
    state.loaded = true;
  } catch (err) {
    state.loaded = true;
    toast(err.message || '불러오지 못했습니다.');
  }
  renderAll();
}

function renderAll() {
  renderHero();
  if (!$('#view-todo').hidden) renderTodo();
  renderCatTabs();
  renderTagChips();
  renderGrid();
  renderFilterLabels();
  renderArtists();
  if (currentRoute().name === 'artist') renderArtistPage(currentRoute().arg);
}

/* ─────────────── 화면 이동 (주소 뒤 #) ─────────────── */

function currentRoute() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  if (h.startsWith('artist/')) return { name: 'artist', arg: h.slice(7) };
  if (h === 'artists') return { name: 'artists' };
  if (h === 'todo') return { name: 'todo' };
  return { name: 'home' };
}

function go(hash) {
  if (location.hash !== hash) location.hash = hash;
  else route();
}

function route() {
  const r = currentRoute();
  $('#view-home').hidden = r.name !== 'home';
  $('#view-artists').hidden = r.name !== 'artists';
  $('#view-artist').hidden = r.name !== 'artist';
  $('#view-todo').hidden = r.name !== 'todo';
  const tab = r.name === 'artist' ? 'artists' : r.name;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  if (r.name === 'todo') renderTodo();
  if (r.name === 'artist') renderArtistPage(r.arg);
  window.scrollTo({ top: 0 });
}

window.addEventListener('hashchange', route);

function bindStatic() {
  $('#brand').onclick = () => { resetFilters(); go('#/'); };
  document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => go(t.dataset.tab === 'home' ? '#/' : `#/${t.dataset.tab}`)));
  $('#todoEdit').onclick = () => { state.todoEditing = !state.todoEditing; renderTodo(); };
  $('#todoNew').onsubmit = addTodoPlace;
  $('#addBtn').onclick = () => (state.loggedIn ? openAddChoice() : openLogin(() => openAddChoice()));
  $('#loginBtn').onclick = () => (state.loggedIn ? logoutFlow() : openLogin());
  $('#moreBtn').onclick = openMore;
  $('#adminBtn').onclick = () => (location.href = '/admin');
  $('#artistBack').onclick = () => go('#/artists');

  $('#search').addEventListener('input', (e) => { state.q = e.target.value; renderGrid(); });
  $('#artistSearch').addEventListener('input', (e) => { state.artistQ = e.target.value; renderArtists(); });
  $('#artistFilterBtn').onclick = pickArtist;
  $('#sortBtn').onclick = pickSort;
  $('#viewModeBtn').onclick = () => {
    state.mode = state.mode === 'grid' ? 'rows' : 'grid';
    localSet('viewMode', state.mode);
    renderFilterLabels();
    renderGrid();
  };

  // 한쪽 키: 키보드의 \ (원화 ₩) 키를 누르면 관리 화면으로 갑니다. 입력칸에 글을 쓰는 중에는 무시합니다.
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '\\' || e.key === '₩' || e.code === 'Backslash') location.href = '/admin';
    if (e.key === '/') { e.preventDefault(); go('#/'); $('#search').focus(); }
    if (/^[0-3]$/.test(e.key) && $('#sheet').hidden) {
      setCat(e.key === '0' ? '' : CATS[Number(e.key) - 1][0]);
      go('#/');
    }
  });

  $('#viewerClose').onclick = () => ($('#viewer').hidden = true);
  $('#viewer').onclick = (e) => { if (e.target.id === 'viewer') $('#viewer').hidden = true; };
}

function renderAuth() {
  $('#loginBtn').textContent = state.loggedIn ? '로그아웃' : '로그인';
  $('#loginBtn').hidden = !!state.open; // 비밀번호 없는 열린 모드에서는 로그인 단추를 숨깁니다
}

/* ─────────────── 검색 · 필터 ─────────────── */

function resetFilters() {
  state.q = '';
  state.artist = '';
  state.cat = '';
  state.tags.clear();
  $('#search').value = '';
  renderAll();
}

function matches(item, q) {
  if (!q) return true;
  const hay = [item.title, item.artist, item.place, item.memo, item.source, ...item.tags].join(' ').toLowerCase();
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return words.every((w) => {
    if (hay.includes(w.replace(/^#/, ''))) return true;
    // 초성만 입력해도 찾기 (예: ㄱㅎ → 고흐)
    if (/^[ㄱ-ㅎ]+$/.test(w)) return choseong(hay).includes(w);
    return false;
  });
}

function filtered() {
  const list = state.items.filter((it) =>
    matches(it, state.q.trim()) &&
    (!state.cat || it.category === state.cat) &&
    (!state.artist || it.artist === state.artist) &&
    [...state.tags].every((t) => it.tags.includes(t))
  );
  const by = {
    new: (a, b) => b.createdAt - a.createdAt,
    old: (a, b) => a.createdAt - b.createdAt,
    title: (a, b) => (a.title || '').localeCompare(b.title || '', 'ko'),
    artist: (a, b) => (a.artist || '힣').localeCompare(b.artist || '힣', 'ko') || b.createdAt - a.createdAt,
  }[state.sort];
  return list.sort(by);
}

/* ─────────────── 첫 화면 게임 카드: 전시 레벨 · AI 에너지 ─────────────── */

// [이만큼 다녀오면, 화분 모습]. 전시를 다녀올수록 식물이 자랍니다. 마지막 모습 뒤로는 20번마다 ★ 레벨이 오릅니다.
const LEVELS = [
  [0, '씨앗'], [1, '새싹'], [3, '떡잎'], [6, '어린 줄기'], [10, '잎이 무성한 풀'],
  [15, '꽃봉오리'], [22, '첫 꽃'], [30, '활짝 핀 꽃'], [45, '열매 맺은 꽃'], [60, '큰 나무'],
];

/* ─────────────── 다마고치 화분 (픽셀 그림) ─────────────── */

// 기분: 마지막 전시가 며칠 전인지로 정합니다. 오늘 물을 주면 한 단계 나아집니다.
const MOODS = ['wilt', 'thirsty', 'ok', 'happy'];
function plantMood(lastAt, watered) {
  if (!lastAt) return { mood: 'ok', days: null };
  const days = Math.max(0, Math.floor((Date.now() - lastAt) / 864e5));
  let m = days <= 7 ? 3 : days <= 21 ? 2 : days <= 45 ? 1 : 0;
  if (watered && m < 3) m += 1;
  return { mood: MOODS[m], days };
}

const PLANT_COLORS = {
  happy: ['#2FB35A', '#1F8A44'], ok: ['#5DB847', '#3F8F35'],
  thirsty: ['#B9B13C', '#8E8A2E'], wilt: ['#A88457', '#7A5E3A'],
};

// stage 0~9, mood happy/ok/thirsty/wilt, kind leaf(전시) / sun(영화 해바라기)
function plantSVG(stage, mood = 'ok', kind = 'leaf') {
  const out = [];
  const px = (x, y, c, w = 1, h = 1) => out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}"/>`);
  const [leaf, stem] = PLANT_COLORS[mood] || PLANT_COLORS.ok;
  const sad = mood === 'thirsty' || mood === 'wilt';
  const dy = sad ? 1 : -1;
  const petal = mood === 'wilt' ? '#D9B8A0' : kind === 'sun' ? '#FFB21E' : '#F27BA0';
  const petal2 = mood === 'wilt' ? '#E6CDBB' : kind === 'sun' ? '#FFD426' : '#F9A8C4';
  const core = kind === 'sun' ? '#7A4A1E' : '#FFD426';

  const top = [];
  const tp = (...a) => { const before = out.length; px(...a); top.push(out.pop()); out.length = before; };
  const leafAt = (y, big) => {
    tp(9, y, leaf, 2, 1); tp(13, y, leaf, 2, 1);
    if (big) { tp(8, y + dy, leaf); tp(15, y + dy, leaf); }
  };
  const H = [0, 2, 3, 5, 7, 8, 9, 10, 10, 0][stage] || 0;
  const t = 16 - H; // 줄기 꼭대기 y
  if (stage === 0) {
    tp(11, 15, '#8B5A2B', 2, 1); tp(12, 14, '#A0703C');
  } else if (stage < 9) {
    tp(11, t, stem, 2, H);
    if (stage <= 4) leafAt(t, stage >= 2);
    for (let k = 0; k < Math.min(3, stage - 2); k++) leafAt(14 - k * 2 - (stage > 4 ? 0 : 1), true);
    if (stage === 5) { tp(11, t - 2, petal, 2, 2); tp(10, t, leaf); tp(13, t, leaf); }
    if (stage >= 6) {
      const c = t - 3;
      tp(11, c - 2, petal, 2, 2); tp(11, c + 2, petal, 2, 2); tp(9, c, petal, 2, 2); tp(13, c, petal, 2, 2);
      if (stage >= 7) { tp(9, c - 2, petal2, 2, 2); tp(13, c - 2, petal2, 2, 2); tp(9, c + 2, petal2, 2, 2); tp(13, c + 2, petal2, 2, 2); }
      tp(11, c, core, 2, 2);
    }
    if (stage === 8) { tp(6, 13, '#F04452', 2, 2); tp(16, 11, '#F04452', 2, 2); tp(6, 12, stem); tp(17, 10, stem); }
  } else {
    tp(11, 9, '#8B5A2B', 2, 7); tp(9, 11, '#8B5A2B', 2, 1); tp(13, 10, '#8B5A2B', 2, 1);
    for (let y = 0; y <= 11; y++) for (let x = 4; x <= 19; x++) {
      const d = (x - 11.5) ** 2 + ((y - 5.5) * 1.15) ** 2;
      if (d <= 40) tp(x, y, d > 28 && (x + y) % 3 === 0 ? stem : leaf);
    }
    if (!sad) { tp(8, 4, '#F04452'); tp(15, 3, '#F04452'); tp(12, 8, '#F04452'); tp(17, 7, '#F04452'); }
  }

  // 화분 + 얼굴
  px(6, 16, '#6B4A33', 12, 1);
  px(5, 17, '#E07A4F', 14, 1);
  px(6, 18, '#F0936A', 12, 5);
  px(7, 23, '#D06A40', 10, 1);
  const ink = '#191F28';
  if (mood === 'wilt') { px(8, 19, ink, 2, 1); px(14, 19, ink, 2, 1); }
  else { px(9, 19, ink); px(14, 19, ink); }
  if (mood === 'happy') { px(10, 20, ink); px(13, 20, ink); px(11, 21, ink, 2, 1); px(8, 20, '#F9A8C4'); px(15, 20, '#F9A8C4'); }
  else if (mood === 'ok') { px(11, 21, ink, 2, 1); }
  else { px(11, 20, ink, 2, 1); px(10, 21, ink); px(13, 21, ink); }

  // 머리 위 표시: 하트 / 물방울 / ...
  const icon = [];
  if (mood === 'happy') icon.push('<path d="M18 1h2v1h1V1h2v2h-1v1h-1v1h-1V4h-1V3h-1z" fill="#F04452"/>');
  if (mood === 'thirsty') icon.push('<rect x="20" y="1" width="1" height="1" fill="#3182F6"/><rect x="19" y="2" width="3" height="2" fill="#3182F6"/>');
  if (mood === 'wilt') icon.push('<rect x="18" y="3" width="1" height="1" fill="#8B95A1"/><rect x="20" y="3" width="1" height="1" fill="#8B95A1"/><rect x="22" y="3" width="1" height="1" fill="#8B95A1"/>');

  return `<svg class="pixel-plant ${mood}" viewBox="0 0 24 24" shape-rendering="crispEdges" aria-hidden="true">
    <g class="pl-top">${top.join('')}</g>${out.join('')}<g class="pl-icon">${icon.join('')}</g>
    <g class="pl-drops"><rect x="9" y="2" width="1" height="2" fill="#3182F6"/><rect x="13" y="0" width="1" height="2" fill="#3182F6"/><rect x="16" y="3" width="1" height="2" fill="#3182F6"/></g>
  </svg>`;
}

// 물 주기 기록: 서버에 저장되어 어느 기기에서나 같습니다 (/api/stats 의 water).
const waterState = () => state.stats?.water || { last: '', streak: 0, total: 0, watered: false };
const wateredToday = () => !!waterState().watered;

function levelOf(n) {
  let i = 0;
  while (i + 1 < LEVELS.length && n >= LEVELS[i + 1][0]) i++;
  if (i === LEVELS.length - 1) {
    const extra = Math.floor((n - LEVELS[i][0]) / 20);
    const from = LEVELS[i][0] + extra * 20;
    return { lv: i + 1 + extra, title: LEVELS[i][1] + (extra ? ` ★${extra}` : ''), from, to: from + 20, nextTitle: `${LEVELS[i][1]} ★${extra + 1}` };
  }
  return { lv: i + 1, title: LEVELS[i][1], from: LEVELS[i][0], to: LEVELS[i + 1][0], nextTitle: LEVELS[i + 1][1] };
}

const num = (n) => Number(n || 0).toLocaleString('ko-KR');

// 관람일: 사진 찍은 날(관람일)이 있으면 그 날, 없으면 올린 날
const seenAt = (i) => i.visitedAt || i.createdAt;
const ymd = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const toDayMs = (v) => (v ? Date.parse(`${v}T12:00:00`) || 0 : 0);

// 방문 횟수 세기: 같은 전시관을 '같은 날 올렸거나' '관람일이 같은' 항목들은 한 번 다녀온 것으로 칩니다.
// (사진 하나만 찍은 날짜가 남아 관람일이 하루 다르게 잡혀도, 같은 날 올린 같은 전시관이면 한 번 — 2026-10-12 국제갤러리 2번으로 셌던 일)
// 전시관 이름이 없는 항목은 그날 다녀온 전시관(항목이 가장 많은 곳)에 붙이고, 그날 전시관이 하나도 없으면 그날 하루를 한 번으로 칩니다.
function uniqueVisits(items) {
  const byKey = new Map();
  const groups = [];
  const find = (g) => { while (g.into) g = g.into; return g; };
  const join = (a, b) => {
    a = find(a); b = find(b);
    if (a !== b) { b.into = a; a.items.push(...b.items); b.items = []; }
    return a;
  };
  const daysOf = (i) => [fmtDate(i.createdAt), fmtDate(seenAt(i))];
  for (const i of items) {
    const k = keyOf(i.place);
    if (!k) continue;
    const [up, seen] = daysOf(i);
    const keys = [`${k}|u${up}`, `${k}|s${seen}`];
    let g = null;
    for (const key of keys) { const h = byKey.get(key); if (h) g = g ? join(g, h) : find(h); }
    if (!g) { g = { place: i.place, items: [] }; groups.push(g); }
    g.items.push(i);
    for (const key of keys) byKey.set(key, g);
  }
  const out = groups.filter((g) => !g.into);
  for (const i of items) {
    if (keyOf(i.place)) continue;
    const days = daysOf(i);
    const top = out.filter((g) => g.place && g.items.some((x) => daysOf(x).some((d) => days.includes(d))))
      .sort((a, b) => b.items.length - a.items.length)[0];
    if (top) { top.items.push(i); continue; }
    let g = out.find((x) => !x.place && x.day === days[1]);
    if (!g) { g = { place: '', day: days[1], items: [] }; out.push(g); }
    g.items.push(i);
  }
  // 다녀온 날 = 묶인 항목 중 가장 이른 관람일 (사진 찍은 날이 있으면 그 날)
  for (const g of out) { g.at = Math.min(...g.items.map(seenAt)); g.key = `${keyOf(g.place) || '?'}|${fmtDate(g.at)}`; }
  return out.sort((a, b) => b.at - a.at);
}

function energyOf(ai) {
  if (!ai) return null;
  const parts = [];
  if (ai.limit?.tokens) parts.push(1 - ai.today.tokens / ai.limit.tokens);
  if (ai.limit?.requests) parts.push(1 - ai.today.requests / ai.limit.requests);
  if (!parts.length) return null;
  return Math.max(0, Math.min(1, Math.min(...parts)));
}

function renderHero() {
  const box = $('#hero');
  if (!box) return;
  const ex = uniqueVisits(state.items.filter((i) => i.category === 'exhibition'));
  const visits = ex.length;
  const L = levelOf(visits);
  const pct = Math.round(((visits - L.from) / (L.to - L.from)) * 100);
  const now = new Date();
  const monthVisits = ex.filter((v) => { const d = new Date(v.at); return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth(); }).length;
  const movies = state.items.filter((i) => i.category === 'movie').length;
  const ai = state.stats?.ai;
  const en = energyOf(ai);
  const enPct = en == null ? null : Math.round(en * 100);
  const enLevel = enPct == null ? 'none' : enPct > 50 ? 'high' : enPct > 20 ? 'mid' : 'low';
  const isClaude = ai?.provider === 'claude';
  const aiCaption = !ai
    ? 'AI 사용량을 불러오지 못했어요'
    : !ai.configured
      ? 'AI 키가 아직 없어요'
      : `오늘 ${num(ai.today.requests)}번${isClaude ? '' : ` · ${num(ai.today.tokens)}토큰`} 썼어요` +
        (en == null ? ' · 눌러서 하루 한도 정하기' : ` · 하루 한도 ${ai.limit.tokens ? `${num(ai.limit.tokens)}토큰` : `${num(ai.limit.requests)}번`}`);

  const stage = Math.min(L.lv - 1, LEVELS.length - 1);
  const watered = wateredToday();
  const { mood, days } = plantMood(ex[0]?.at, watered);
  const W = waterState();
  const say = !visits
    ? '전시를 한 번 다녀오면 싹이 터요'
    : mood === 'happy' ? (days === 0 ? '오늘 전시 덕분에 쑥쑥 자랐어요!' : `${days}일 전에 전시를 봤어요. 기분 최고!`)
      : mood === 'ok' ? `마지막 전시가 ${days}일 전이에요. 슬슬 보러 갈까요?`
        : mood === 'thirsty' ? `${days}일째 전시를 못 봤어요… 목말라요`
          : `${days}일째… 시들고 있어요. 전시 한 번이면 살아나요!`;

  box.innerHTML = `
    <div class="hero-top">
      <button class="tama" id="tama" type="button" aria-label="화분이랑 놀기"><span class="tama-screen">${plantSVG(stage, mood)}</span></button>
      <div class="hero-title">
        <span>내 전시 화분 · Lv.${L.lv}</span>
        <strong>${esc(L.title)}</strong>
        <p class="tama-say" id="tamaSay">${esc(say)}</p>
      </div>
    </div>
    <div class="tama-actions">
      <button type="button" id="waterBtn" class="${watered ? 'done' : ''}"><span class="ta-ic">💧</span>${watered ? `물 줬어요${W.streak > 1 ? ` · ${W.streak}일째` : ''}` : '물 주기'}</button>
      <button type="button" id="playBtn"><span class="ta-ic">✋</span>쓰다듬기</button>
      <button type="button" id="visitsBtn"><span class="ta-ic">🖼️</span><span><b>${state.loaded ? visits : '-'}</b>번 다녀옴</span></button>
    </div>
    <div class="bar xp" role="progressbar" aria-label="다음 모습까지" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>
    <p class="bar-caption">다음 모습 <b>${esc(L.nextTitle)}</b>까지 전시 ${L.to - visits}번 · 전시를 다녀와야 자라요</p>
    <div class="hero-chips">
      ${state.todo.length ? `<button type="button" class="quest-chip" id="questChip">${ICON.pin}가볼 곳 <b>${todoProgress().done}/${state.todo.length}</b></button>` : ''}
      <span>이번 달 전시 <b>${monthVisits}</b></span><button type="button" class="hero-chip-btn" id="movieChip">🌻 ${new Date().getFullYear()}년 영화 <b>${moviesByYear().get(new Date().getFullYear())?.size || 0}편</b> · ${movieLevel(moviesByYear().get(new Date().getFullYear())?.size || 0).title}</button><span>작가 <b>${state.artists.length}</b></span>
    </div>
    <button class="energy" id="energyBtn" type="button">
      <span class="energy-head"><span class="energy-label">${ICON.spark}AI 에너지${isClaude ? ' (Claude)' : ''}</span><b>${enPct == null ? '한도 미정' : `${enPct}%`}</b></span>
      <span class="bar energy-bar ${enLevel}"><i style="width:${enPct == null ? 100 : enPct}%"></i></span>
      <span class="bar-caption">${esc(aiCaption)}</span>
    </button>`;
  const sayIt = (t) => { const el = $('#tamaSay'); if (el) el.textContent = t; };
  const bounce = (cls) => { const el = $('#tama'); el.classList.remove('jump', 'drink'); void el.offsetWidth; el.classList.add(cls); };
  $('#waterBtn').onclick = () => {
    if (wateredToday()) { bounce('jump'); return sayIt('오늘은 벌써 물 마셨어요. 내일 또 주세요!'); }
    needLogin(async () => {
      try {
        const { water, already } = await api('/api/water', { method: 'POST' });
        state.stats = { ...(state.stats || {}), water };
        renderHero();
        if (already) { bounce('jump'); return sayIt('오늘은 벌써 물 마셨어요. 내일 또 주세요!'); }
        bounce('drink');
        sayIt(water.streak > 1 ? `꿀꺽꿀꺽! ${water.streak}일 연속 물 고마워요` : '꿀꺽꿀꺽! 물 고마워요');
      } catch (err) { toast(err.message); }
    });
  };
  const PLAY = !visits
    ? ['간지러워요! 얼른 싹 틔우고 싶어요', '전시 보러 가면 저도 데려가 주세요']
    : mood === 'happy' || mood === 'ok'
      ? ['헤헤, 간지러워요!', '다음엔 어떤 전시 보러 가요?', '사진 많이 찍어 와요!', `가볼 곳이 ${Math.max(0, state.todo.length - todoProgress().done)}곳 남았어요`, '빛이 좋은 전시가 보고 싶어요']
      : ['기운이 없어요…', '전시 보러 가면 다시 힘이 날 것 같아요', '가볼 곳 목록 한번 볼까요?'];
  $('#playBtn').onclick = $('#tama').onclick = () => { bounce('jump'); sayIt(PLAY[Math.floor(Math.random() * PLAY.length)]); };
  $('#energyBtn').onclick = openEnergy;
  $('#visitsBtn').onclick = openVisits;
  $('#movieChip').onclick = openMovies;
  if ($('#questChip')) $('#questChip').onclick = () => go('#/todo');

  // 레벨 업 축하 (지난번 본 레벨보다 오르면 한 번)
  if (state.loaded) {
    const seen = Number(localGet('lv') || 0);
    if (seen && L.lv > seen) {
      toast(`쑥쑥 자랐어요! 이제 "${L.title}" (Lv.${L.lv})`);
      box.classList.remove('levelup'); void box.offsetWidth; box.classList.add('levelup');
    }
    localSet('lv', String(L.lv));
  }
}

// 전시 다녀온 기록: 같은 날·같은 전시관으로 묶인 항목들을 보여줘서 횟수를 확인할 수 있게 합니다.
function openVisits() {
  const exItems = state.items.filter((i) => i.category === 'exhibition');
  const visits = uniqueVisits(exItems);
  openSheet(`
    <h2>전시 다녀온 기록 ${visits.length}번</h2>
    <p class="hint" style="margin:-8px 0 16px;line-height:1.6">전시 항목 ${exItems.length}개를 <b>같은 날(관람일) · 같은 전시관</b>끼리 묶어서 한 번으로 셌어요. 여러 항목으로 나뉜 관람은 <b>한 항목으로 합치기</b>를 누르면 사진이 한곳에 모여요.</p>
    <ul class="visit-list">${visits.map((v, n) => `<li>
      <div class="visit-date">${fmtDate(v.at)}</div>
      <div class="visit-main">
        <strong>${esc(v.place || '전시관 이름 없음')}</strong>
        <span>${v.items.map((i) => esc(i.title || '제목 없음')).join(' · ')}</span>
        ${v.items.length > 1 ? `<button class="btn small merge-btn" data-n="${n}" type="button">한 항목으로 합치기 (${v.items.length}개 → 1개)</button>` : ''}
      </div>
      <b class="visit-n">${v.items.length}개</b>
    </li>`).join('')}</ul>
    <p class="hint" style="margin-top:14px">잘못 묶였으면 그 항목을 열어 전시관 이름이나 관람일을 고쳐 주세요.</p>`);
  sheetBody().querySelectorAll('.merge-btn').forEach((b) => (b.onclick = () => needLogin(async () => {
    const v = visits[Number(b.dataset.n)];
    // 사진이 가장 많은 항목을 남기고 나머지를 그 안으로 모읍니다.
    const keep = [...v.items].sort((a, c) => c.images.length - a.images.length || a.createdAt - c.createdAt)[0];
    setBusy(b, true);
    try {
      const { item, removed } = await api('/api/items/merge', { method: 'POST', body: { ids: v.items.map((i) => i.id), keep: keep.id } });
      state.items = state.items.filter((i) => !removed.includes(i.id)).map((i) => (i.id === item.id ? item : i));
      renderAll();
      toast(`"${item.title || v.place}" 한 항목으로 합쳤어요 (사진 ${item.images.length}장)`);
      openVisits();
    } catch (err) { toast(err.message); setBusy(b, false); }
  })));
}

/* ─────────────── 사진 옮기기 ─────────────── */

// 잘못 묶인 사진 한 장을 골라 다른 항목으로 옮깁니다. 같은 날·같은 전시관 항목을 먼저 보여줍니다.
function openMove(it, picked = null) {
  const near = (x) => (fmtDate(seenAt(x)) === fmtDate(seenAt(it)) ? 2 : 0) + (x.place && keyOf(x.place) === keyOf(it.place) ? 1 : 0);
  const targets = state.items.filter((x) => x.id !== it.id).sort((a, b) => near(b) - near(a) || seenAt(b) - seenAt(a)).slice(0, 40);
  openSheet(`
    <h2>사진 옮기기</h2>
    <p class="hint" style="margin:-8px 0 12px">1. 옮길 사진을 고르고 2. 옮길 항목을 누르세요.</p>
    <div class="move-photos">${it.images.map((k) => `<button type="button" class="move-ph ${picked === k ? 'on' : ''}" data-k="${k}"><img src="/img/${k}" alt="" /></button>`).join('')}</div>
    <ul class="options move-targets">${targets.map((x) => `<li><button data-id="${x.id}" ${picked ? '' : 'disabled'}>
      <span><strong>${esc(x.title || '제목 없음')}</strong><small>${esc([catLabel(x.category), x.place, fmtDate(seenAt(x))].filter(Boolean).join(' · '))}</small></span>
      <span class="n">${x.images.length}장</span></button></li>`).join('')}</ul>`);
  sheetBody().querySelectorAll('.move-ph').forEach((b) => (b.onclick = () => openMove(it, b.dataset.k)));
  sheetBody().querySelectorAll('.move-targets button').forEach((b) => (b.onclick = async () => {
    if (!picked) return toast('먼저 옮길 사진을 골라 주세요');
    setBusy(b, true);
    try {
      const { from, to } = await api(`/api/items/${it.id}/move`, { method: 'POST', body: { image: picked, to: b.dataset.id } });
      state.items = state.items.filter((x) => x.id !== it.id || from).map((x) => (from && x.id === from.id ? from : x.id === to.id ? to : x));
      renderAll();
      toast(`"${to.title || '항목'}"(으)로 옮겼어요`);
      if (from && from.images.length) openMove(from); else closeSheet();
    } catch (err) { toast(err.message); setBusy(b, false); }
  }));
}

/* ─────────────── 연도별 영화 기록 (게임) ─────────────── */

// 한 해에 본 영화 수로 칭호를 정합니다. 같은 해 같은 제목은 1편.
const MOVIE_TITLES = [[0, '영화 쉬는 중'], [1, '영화 입문'], [5, '주말 관객'], [12, '한 달 한 편'], [24, '시네필'], [52, '매주 한 편'], [100, '영화광']];

function moviesByYear() {
  const map = new Map();
  for (const i of state.items.filter((x) => x.category === 'movie')) {
    const y = new Date(seenAt(i)).getFullYear();
    if (!map.has(y)) map.set(y, new Map());
    const k = keyOf(i.title) || i.id;
    const m = map.get(y);
    if (!m.has(k)) m.set(k, { title: i.title || '제목 없음', at: seenAt(i), items: [] });
    m.get(k).items.push(i);
  }
  return map;
}

function movieLevel(n) {
  let i = 0;
  while (i + 1 < MOVIE_TITLES.length && n >= MOVIE_TITLES[i + 1][0]) i++;
  const next = MOVIE_TITLES[i + 1];
  return { lv: i, title: MOVIE_TITLES[i][1], next: next ? { at: next[0], title: next[1] } : null, from: MOVIE_TITLES[i][0] };
}

function openMovies() {
  const by = moviesByYear();
  const now = new Date().getFullYear();
  const years = [...new Set([now, ...by.keys()])].sort((a, b) => b - a);
  const max = Math.max(1, ...years.map((y) => by.get(y)?.size || 0));
  const thisYear = by.get(now)?.size || 0;
  const L = movieLevel(thisYear);
  const best = years.reduce((b, y) => ((by.get(y)?.size || 0) > (by.get(b)?.size || 0) ? y : b), now);
  openSheet(`
    <h2>연도별 영화 기록</h2>
    <div class="movie-hero">
      <span class="tama small"><span class="tama-screen">${plantSVG([0, 1, 3, 5, 6, 7, 8][L.lv] ?? 8, thisYear ? 'happy' : 'ok', 'sun')}</span></span>
      <div class="hero-title"><span>${now}년 영화 해바라기 · Lv.${L.lv}</span><strong>${L.title}</strong></div>
      <div class="hero-visits"><b>${thisYear}</b><small>편</small></div>
    </div>
    ${L.next ? `<span class="bar movie-bar"><i style="width:${Math.round(((thisYear - L.from) / (L.next.at - L.from)) * 100)}%"></i></span>
    <p class="hint" style="margin:8px 0 18px">다음 칭호 <b>${L.next.title}</b>까지 ${L.next.at - thisYear}편</p>` : '<p class="hint">최고 칭호예요!</p>'}
    <div class="year-chart" role="img" aria-label="연도별 본 영화 수">
      ${years.map((y) => { const n = by.get(y)?.size || 0; return `<div class="year-row ${y === now ? 'now' : ''}">
        <span class="year-label">${y}</span>
        <span class="year-track"><i style="width:${Math.round((n / max) * 100)}%"></i></span>
        <b class="year-n">${n}편</b>${y === best && n ? '<em>최고 기록</em>' : ''}
      </div>`; }).join('')}
    </div>
    <h3 class="section-title" style="margin:24px 0 10px">${now}년에 본 영화</h3>
    ${thisYear ? `<ul class="visit-list">${[...by.get(now).values()].sort((a, b) => b.at - a.at).map((m) => `<li>
      <div class="visit-date">${fmtDate(m.at)}</div>
      <div class="visit-main"><strong>${esc(m.title)}</strong><span>${esc([...new Set(m.items.map((i) => i.artist).filter(Boolean))].join(', '))}</span></div>
      ${m.items.length > 1 ? `<b class="visit-n">${m.items.length}개</b>` : ''}
    </li>`).join('')}</ul>` : '<p class="hint">아직 올해 본 영화가 없어요. 영화 분류로 레퍼런스를 넣으면 여기에 쌓여요.</p>'}
    <p class="hint" style="margin-top:14px">같은 해에 같은 제목은 1편으로 셌어요. 연도는 관람일(없으면 올린 날) 기준이에요.</p>`);
}

/* ─────────────── 더보기: 백업 · 되살리기 · 홈 화면 앱 ─────────────── */

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

function openMore() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  openSheet(`
    <h2>더보기</h2>
    <ul class="options">
      <li><button data-a="export">백업 받기 <span class="n">글·작가·계획·가볼 곳</span></button></li>
      <li><button data-a="import">백업에서 되살리기</button></li>
      ${standalone ? '' : '<li><button data-a="install">휴대폰 홈 화면에 앱으로 추가</button></li>'}
      <li><button data-a="login">${state.loggedIn && !state.open ? '로그아웃' : '로그인'}</button></li>
    </ul>
    <input type="file" id="importInput" accept="application/json,.json" hidden />
    <div id="moreInfo"></div>`);
  const info = (html) => { $('#moreInfo').innerHTML = `<div class="more-info">${html}</div>`; };
  sheetBody().querySelectorAll('[data-a]').forEach((b) => (b.onclick = async () => {
    const a = b.dataset.a;
    if (a === 'export') {
      if (!state.loggedIn) return openLogin(openMore);
      // 받은 파일은 휴대폰 '파일' 앱이나 컴퓨터 '다운로드' 폴더에 저장돼요.
      const link = document.createElement('a');
      link.href = '/api/export';
      link.download = '';
      document.body.appendChild(link); link.click(); link.remove();
      info('백업 파일을 받았어요. 사진 파일은 크기 때문에 빠지고, 사진 이름표만 들어가요 (사진은 사이트에 그대로 남아요). 한 달에 한 번쯤 받아 두면 좋아요.');
    }
    if (a === 'import') {
      if (!state.loggedIn) return openLogin(openMore);
      $('#importInput').click();
    }
    if (a === 'install') {
      if (installPrompt) { installPrompt.prompt(); installPrompt = null; return; }
      info(ios
        ? '아이폰: 사파리 아래쪽 <b>공유 단추(네모에 위 화살표)</b> → <b>홈 화면에 추가</b> → 추가. 홈 화면의 "레퍼런스" 아이콘으로 앱처럼 열려요.'
        : '안드로이드·크롬: 오른쪽 위 <b>⋮</b> → <b>홈 화면에 추가</b>(또는 앱 설치) → 설치.');
    }
    if (a === 'login') { await closeSheet(); state.loggedIn && !state.open ? logoutFlow() : openLogin(); }
  }));
  $('#importInput').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const { counts } = await api('/api/import', { method: 'POST', body: data });
      info(`되살렸어요: ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(' · ')}. 같은 자료는 백업 내용으로 덮어쓰고, 지금 있는 다른 자료는 그대로 둬요.`);
      await loadAll();
    } catch (err) {
      info(`되살리지 못했어요: ${esc(err.message || '파일을 읽지 못했어요')}`);
    }
  };
}

function openEnergy() {
  const ai = state.stats?.ai;
  if (!ai) return toast('AI 사용량을 불러오지 못했어요');
  const isClaude = ai.provider === 'claude';
  openSheet(`
    <h2>AI 에너지</h2>
    <div class="energy-table">
      <div><span>오늘 (${esc(ai.day)})</span><b>${num(ai.today.requests)}번${isClaude ? '' : ` · ${num(ai.today.tokens)}토큰`}</b></div>
      <div><span>이번 달</span><b>${num(ai.month.requests)}번${isClaude ? '' : ` · ${num(ai.month.tokens)}토큰`}</b></div>
    </div>
    <p class="hint" style="margin:12px 0 20px;line-height:1.6">${isClaude
      ? 'Claude 판은 사장님 Claude 계정 사용량을 씁니다. 남은 양은 Claude가 알려주지 않아서, 이 앱에서 부른 횟수만 셉니다.'
      : '구글은 남은 토큰을 앱에 알려주지 않아요. 그래서 이 앱이 쓴 양을 직접 세고, 아래 하루 한도에서 빼서 보여줍니다. 무료 한도는 Google AI Studio 의 사용량 화면에서 확인할 수 있어요.'}</p>
    <form class="form" id="energyForm">
      ${isClaude ? '' : `<label><span class="label">하루 토큰 한도 (0 = 안 정함)</span>
        <input class="field" id="limTokens" type="number" min="0" step="1000" inputmode="numeric" value="${ai.limit.tokens || ''}" placeholder="예) 1000000" /></label>`}
      <label><span class="label">하루 AI 사용 횟수 한도 (0 = 안 정함)</span>
        <input class="field" id="limReq" type="number" min="0" step="1" inputmode="numeric" value="${ai.limit.requests || ''}" placeholder="예) 200" /></label>
      ${isClaude ? '' : `<label><span class="label">1분에 쓸 수 있는 횟수 (0 = 안 정함)</span>
        <input class="field" id="limRpm" type="number" min="0" step="1" inputmode="numeric" value="${ai.limit.rpm || ''}" placeholder="예) 8" /></label>
      <p class="hint" style="margin:-4px 0 0">AI Studio → 비율 제한 화면의 숫자보다 조금 낮게 적으면, 구글 한도(429)에 걸리기 전에 앱이 먼저 멈춰요. 한도를 넘으면 AI 단추가 쉬어요.</p>`}
      <button class="btn block" id="limSave" type="submit">저장</button>
    </form>`);
  $('#energyForm').onsubmit = async (e) => {
    e.preventDefault();
    setBusy($('#limSave'), true);
    try {
      const body = { aiDailyRequests: $('#limReq').value };
      if ($('#limTokens')) body.aiDailyTokens = $('#limTokens').value;
      if ($('#limRpm')) body.aiRpm = $('#limRpm').value;
      state.stats = await api('/api/settings', { method: 'PUT', body });
      await closeSheet();
      renderHero();
      toast('하루 한도를 저장했어요');
    } catch (err) {
      toast(err.message);
      setBusy($('#limSave'), false);
    }
  };
}

/* ─────────────── 전시관 정보 팝업: 위치 · 운영시간 · 휴관일 · 지금 하는 전시 ─────────────── */

const VENUE_STALE = 7 * 24 * 3600 * 1000; // 7일 지나면 새로 찾기

async function openVenue(name, keys = null) {
  const mine = (keys ? state.items.filter((i) => placeMatches(i.place, keys)) : state.items.filter((i) => i.place === name))
    .sort((a, b) => seenAt(b) - seenAt(a));
  const head = `
    <h2 class="venue-title" id="vTitle">${esc(name)}</h2>
    <p class="venue-mine">${mine.length ? `내가 다녀온 기록 <b>${uniqueVisits(mine).length}번</b> · 마지막 ${fmtDate(seenAt(mine[0]))}` : '아직 기록이 없어요'}</p>
    <div class="venue-maps">
      <a class="btn small ghost" href="https://map.naver.com/p/search/${encodeURIComponent(name)}" target="_blank" rel="noopener noreferrer">${ICON.pin}네이버 지도</a>
      <a class="btn small ghost" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}" target="_blank" rel="noopener noreferrer">${ICON.pin}구글 지도</a>
    </div>`;
  openSheet(`${head}<div id="venueBody"><div class="venue-loading"><i class="spin"></i>저장해 둔 정보를 불러오는 중…</div></div>`);

  const show = (v) => {
    const body = $('#venueBody');
    if (!body) return;
    if (!v) {
      body.innerHTML = `<p class="hint" style="margin:16px 0">아직 찾아 둔 정보가 없어요.</p>
        <button class="btn block" id="vRefresh" type="button">${ICON.spark}구글에서 정보 찾기</button>`;
      $('#vRefresh').onclick = () => refresh();
      return;
    }
    state.venues[name] = v;
    const i = v.info || {};
    if (i.name && $('#vTitle')) $('#vTitle').textContent = i.name;
    const row = (label, val, html) => (val ? `<div class="vrow"><span>${label}</span><div>${html || esc(val)}</div></div>` : '');
    const site = /^https?:\/\//i.test(i.website) ? i.website : i.website ? `https://${i.website}` : '';
    body.innerHTML = `
      <div class="vinfo">
        ${row('주소', i.address)}
        ${row('운영시간', i.hours, `<span class="pre">${esc(i.hours)}</span>`)}
        ${row('휴관일', i.closed)}
        ${row('관람료', i.admission)}
        ${row('전화', i.phone)}
        ${row('홈페이지', i.website, `<a href="${esc(site)}" target="_blank" rel="noopener noreferrer">${esc(i.website)}</a>`)}
      </div>
      ${!i.address && !i.hours && !i.closed ? '<p class="hint">주소·운영시간을 확인하지 못했어요. 지도에서 찾아 주세요.</p>' : ''}
      <h3 class="section-title" style="margin:24px 0 10px">지금 하는 전시</h3>
      ${(i.exhibitions || []).length ? `<ul class="vex">${i.exhibitions.map((e, n) => `<li>
          <strong>${esc(e.title)}</strong>
          <span>${esc([e.period, e.artist].filter(Boolean).join(' · '))}</span>
          ${e.desc ? `<p>${esc(e.desc)}</p>` : ''}
          ${state.wish.some((w) => w.title === e.title && w.venue === name)
            ? '<em class="wish-done">보고 싶은 전시에 담았어요</em>'
            : `<button class="btn small wish-add" data-n="${n}" type="button">보고 싶어요</button>`}
        </li>`).join('')}</ul>` : '<p class="hint">진행 중인 전시를 확인하지 못했어요. 홈페이지에서 확인해 주세요.</p>'}
      ${i.notes ? `<p class="vnotes">${esc(i.notes)}</p>` : ''}
      ${(v.sources || []).length ? `<ul class="sources">${v.sources.map((s) => `<li><a href="${esc(s.uri)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a></li>`).join('')}</ul>` : ''}
      <p class="venue-foot">${fmtDate(v.updatedAt)}에 AI가 ${v.sources?.length ? '구글 검색으로 ' : ''}정리한 정보예요. 틀릴 수 있으니 가기 전에 홈페이지에서 꼭 확인하세요.</p>
      <button class="btn ghost block" id="vRefresh" type="button">${ICON.spark}정보 새로 찾기</button>`;
    $('#vRefresh').onclick = () => refresh();
    body.querySelectorAll('.wish-add').forEach((b) => (b.onclick = () => needLogin(async () => {
      const e = i.exhibitions[Number(b.dataset.n)];
      try {
        const { wish } = await api('/api/wish', { method: 'POST', body: { venue: name, title: e.title, period: e.period, artist: e.artist } });
        if (!state.wish.some((w) => w.id === wish.id)) state.wish.push(wish);
        toast('보고 싶은 전시에 담았어요');
        show(v);
        if (!$('#view-todo').hidden) renderTodo();
      } catch (err) { toast(err.message); }
    })));
  };

  const refresh = async () => {
    if (!state.loggedIn) return openLogin(() => openVenue(name));
    const body = $('#venueBody');
    if (body) body.innerHTML = '<div class="venue-loading"><i class="spin"></i>구글에서 운영시간·휴관일·지금 하는 전시를 찾는 중… (20초쯤 걸려요)</div>';
    try {
      const { venue } = await api(`/api/venues/${encodeURIComponent(name)}/refresh`, { method: 'POST' });
      loadStats();
      show(venue);
    } catch (err) {
      toast(err.message);
      const { venue } = await api(`/api/venues/${encodeURIComponent(name)}`).catch(() => ({ venue: null }));
      show(venue);
    }
  };

  try {
    const { venue } = await api(`/api/venues/${encodeURIComponent(name)}`);
    if ((!venue || Date.now() - venue.updatedAt > VENUE_STALE) && state.loggedIn && state.stats?.ai?.configured !== false) {
      show(venue);
      refresh();
    } else show(venue);
  } catch (err) {
    show(null);
    toast(err.message);
  }
}

/* ─────────────── 가볼 곳 (퀘스트) ─────────────── */

// 레퍼런스의 전시관 이름에 가볼 곳의 열쇠 글자가 들어 있으면 다녀온 것으로 칩니다. (리움 → 리움미술관)
function placeMatches(place, keys) {
  const p = keyOf(place);
  return !!p && keys.some((k) => { const kk = keyOf(k); return kk && (p.includes(kk) || kk.includes(p)); });
}
// 가볼 곳 하나의 방문 기록 (같은 날 여러 항목이면 1번)
const visitsOf = (t) => uniqueVisits(state.items.filter((i) => placeMatches(i.place, t.keys?.length ? t.keys : [t.name])));
const venueQuery = (name) => name.replace(/\s*\(.*\)\s*$/, '');

function todoProgress() {
  const done = state.todo.filter((t) => t.done || visitsOf(t).length).length;
  return { done, total: state.todo.length };
}

function renderTodo() {
  const { done, total } = todoProgress();
  $('#todoSum').innerHTML = total ? `${total}곳 중 <b>${done}곳</b> 다녀왔어요${done === total ? ' · 퀘스트 완료!' : ''}` : '아직 가볼 곳이 없어요';
  $('#todoBar').style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  $('#todoEdit').textContent = state.todoEditing ? '완료' : '편집';
  const areas = [...new Set(state.todo.map((t) => t.area || '기타'))];
  $('#todoAreas').innerHTML = areas.map((a) => `<option value="${esc(a)}"></option>`).join('');
  $('#todoGroups').innerHTML = areas.map((area) => {
    const list = state.todo.filter((t) => (t.area || '기타') === area);
    const n = list.filter((t) => t.done || visitsOf(t).length).length;
    return `<section class="quest-group">
      <h3 class="quest-area">${esc(area)} <span>${n}/${list.length}</span>${list.length > 1 ? `<button class="course-btn" data-area="${esc(area)}" type="button">${ICON.pin}코스 짜기</button>` : ''}</h3>
      <ul class="quest-list">${list.filter((t) => !state.todoOpenOnly || openOn(t, new Date()) !== false).map((t) => {
        const v = visitsOf(t);
        const ok = v.length || t.done;
        return `<li class="${ok ? 'ok' : ''}">
          <button class="quest-check" data-id="${t.id}" type="button" aria-label="${ok ? '다녀옴' : '아직'}" ${v.length ? 'disabled' : ''}>${ok ? '<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>' : ''}</button>
          <button class="quest-main" data-id="${t.id}" type="button">
            <strong>${esc(t.name)}</strong>
            <span>${v.length ? `다녀옴 ${v.length}번 · 마지막 ${fmtDate(Math.max(...v.map((x) => x.at)))}` : t.done ? '다녀옴 (직접 표시)' : '운영시간 · 지금 하는 전시 보기'}</span>
            ${weekStrip(t)}
          </button>
          ${state.todoEditing ? `<button class="quest-del" data-id="${t.id}" type="button" aria-label="빼기">${ICON.x}</button>` : ICON.chevron}
        </li>`;
      }).join('')}</ul>
    </section>`;
  }).join('');
  $('#todoGroups').insertAdjacentHTML('afterbegin', wishSection() + todoTools());
  const find = (el) => state.todo.find((t) => t.id === el.dataset.id);
  $('#todoGroups').querySelectorAll('.course-btn').forEach((b) => (b.onclick = () => openCourse(b.dataset.area)));
  if ($('#openOnly')) $('#openOnly').onclick = () => { state.todoOpenOnly = !state.todoOpenOnly; renderTodo(); };
  if ($('#fetchAll')) $('#fetchAll').onclick = () => needLogin(fetchAllVenues);
  $('#todoGroups').querySelectorAll('.wish-check').forEach((b) => (b.onclick = () => needLogin(async () => {
    const w = state.wish.find((x) => x.id === b.dataset.id);
    try {
      const { wish } = await api(`/api/wish/${w.id}`, { method: 'PUT', body: { done: !w.done } });
      state.wish = state.wish.map((x) => (x.id === w.id ? wish : x));
      renderTodo();
    } catch (err) { toast(err.message); }
  })));
  $('#todoGroups').querySelectorAll('.wish-del').forEach((b) => (b.onclick = () => needLogin(async () => {
    try {
      await api(`/api/wish/${b.dataset.id}`, { method: 'DELETE' });
      state.wish = state.wish.filter((x) => x.id !== b.dataset.id);
      renderTodo();
    } catch (err) { toast(err.message); }
  })));
  $('#todoGroups').querySelectorAll('.wish-venue').forEach((b) => (b.onclick = () => openVenue(b.dataset.v)));
  $('#todoGroups').querySelectorAll('.quest-main').forEach((b) => (b.onclick = () => { const t = find(b); openVenue(venueQuery(t.name), t.keys?.length ? t.keys : [t.name]); }));
  $('#todoGroups').querySelectorAll('.quest-check').forEach((b) => (b.onclick = () => needLogin(() => toggleTodo(find(b)))));
  $('#todoGroups').querySelectorAll('.quest-del').forEach((b) => (b.onclick = () => needLogin(() => removeTodo(find(b)))));
}

const needLogin = (fn) => (state.loggedIn ? fn() : openLogin(fn));

/* ── 이번 주 열린 곳 ── */
const DAYS = '일월화수목금토';
const venueOfTodo = (t) => state.venues[venueQuery(t.name)] || null;

// 휴관일 글에서 쉬는 요일을 찾습니다: "매주 월요일" → 월, "월·화요일 휴관" → 월·화. 모르면 null.
function closedDays(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  const out = new Set();
  for (const m of t.matchAll(/((?:[월화수목금토일][\s·,/및와]*)+)요일/g)) for (const ch of m[1]) { const i = DAYS.indexOf(ch); if (i >= 0) out.add(i); }
  if (/연중무휴|휴관일?\s*없/.test(t)) return new Set();
  return out;
}

// 그 날 열려 있는지: true / false / null(모름). 공휴일·명절 휴관은 반영하지 못합니다.
function openOn(t, date) {
  const v = venueOfTodo(t);
  if (!v) return null;
  const closed = closedDays(v.info?.closed);
  if (!closed) return null;
  return !closed.has(date.getDay());
}

function weekStrip(t) {
  const v = venueOfTodo(t);
  if (!v) return '';
  const today = new Date();
  return `<span class="week-strip" aria-label="이번 주 여는 날">${[...Array(7)].map((_, k) => {
    const d = new Date(today); d.setDate(today.getDate() + k);
    const o = openOn(t, d);
    return `<i class="${o === true ? 'open' : o === false ? 'closed' : 'unknown'}${k === 0 ? ' today' : ''}" title="${d.getMonth() + 1}/${d.getDate()}">${DAYS[d.getDay()]}</i>`;
  }).join('')}</span>`;
}

function todoTools() {
  const missing = state.todo.filter((t) => !venueOfTodo(t));
  return `<div class="todo-tools">
    <button type="button" class="chip ${state.todoOpenOnly ? 'on' : ''}" id="openOnly">오늘 열린 곳만</button>
    ${missing.length ? `<button type="button" class="chip" id="fetchAll">${ICON.spark}정보 없는 ${missing.length}곳 찾기 (AI ${missing.length}번)</button>` : ''}
  </div>
  <p class="hint" style="margin:6px 0 0">초록 = 여는 날 · 빨강 = 휴관일 · 회색 = 모름. 공휴일·명절 휴관은 빠질 수 있어요.</p>`;
}

// 정보가 없는 가볼 곳을 차례로 찾습니다. AI 한도(분당 4번)에 맞춰 16초 간격.
async function fetchAllVenues() {
  const missing = state.todo.filter((t) => !venueOfTodo(t));
  if (!missing.length) return;
  const btn = $('#fetchAll');
  if (btn) { btn.disabled = true; }
  let done = 0;
  for (const t of missing) {
    const name = venueQuery(t.name);
    if (btn) btn.textContent = `찾는 중… ${done}/${missing.length} (${name})`;
    try {
      const { venue } = await api(`/api/venues/${encodeURIComponent(name)}/refresh`, { method: 'POST' });
      state.venues[name] = venue;
      done++;
    } catch (err) {
      toast(`${name}: ${err.message}`);
      if (err.status === 429) break; // 한도에 걸리면 멈춤
    }
    if (!$('#view-todo').hidden) renderTodo();
    if (done < missing.length) await new Promise((r) => setTimeout(r, 16000));
  }
  loadStats();
  toast(`전시관 정보 ${done}곳을 찾았어요`);
  if (!$('#view-todo').hidden) renderTodo();
}

/* ── 코스 짜기 ── */
const ANGUK = { name: '안국역', lat: 37.5765, lng: 126.9855 };
function km(a, b) {
  const R = 6371; const r = (x) => (x * Math.PI) / 180;
  const dLat = r(b.lat - a.lat); const dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// 가까운 곳부터 차례로 잇는 간단한 코스 (위치는 AI가 찾은 대략 좌표라 실제 길과 다를 수 있음)
function openCourse(area) {
  const list = state.todo.filter((t) => (t.area || '기타') === area);
  const withPos = list.map((t) => ({ t, name: venueQuery(t.name), v: venueOfTodo(t) }))
    .map((x) => ({ ...x, lat: x.v?.info?.lat, lng: x.v?.info?.lng }));
  const known = withPos.filter((x) => typeof x.lat === 'number');
  const unknown = withPos.filter((x) => typeof x.lat !== 'number');
  const start = /안국/.test(area) ? ANGUK : known[0] || null;
  const route = [];
  let cur = start; const left = [...known];
  while (left.length && cur) {
    left.sort((a, b) => km(cur, a) - km(cur, b));
    const next = left.shift();
    route.push({ ...next, dist: km(cur, next) });
    cur = next;
  }
  const total = route.reduce((a, r) => a + r.dist, 0);
  const walking = total <= 5;
  const today = new Date();
  const names = route.map((r) => r.name);
  const origin = start === ANGUK ? '안국역' : names[0];
  const stops = start === ANGUK ? names : names.slice(1);
  const gmap = stops.length ? `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(stops[stops.length - 1])}${stops.length > 1 ? `&waypoints=${encodeURIComponent(stops.slice(0, -1).join('|'))}` : ''}&travelmode=${walking ? 'walking' : 'transit'}` : '';
  openSheet(`
    <h2>${esc(area)} 코스</h2>
    ${route.length ? `<p class="hint" style="margin:-8px 0 14px">${start === ANGUK ? '안국역에서 출발해 ' : ''}가까운 곳부터 이었어요 · 직선거리 약 ${total.toFixed(1)}km${walking ? ` · 걸어서 ${Math.round(total * 15)}분쯤 + 관람` : ''}</p>
    <ol class="course">${route.map((r, k) => {
      const o = openOn(r.t, today);
      return `<li><span class="course-n">${k + 1}</span><div><strong>${esc(r.name)}</strong>
        <small>${r.dist < 1 ? `${Math.round(r.dist * 1000)}m` : `${r.dist.toFixed(1)}km`} · ${o === false ? '<b class="closed">오늘 휴관</b>' : o === true ? '오늘 열어요' : '오늘 여는지 모름'}</small></div>
        <button class="text-btn small" data-v="${esc(r.name)}" type="button">정보</button></li>`;
    }).join('')}</ol>
    <a class="btn block" href="${gmap}" target="_blank" rel="noopener noreferrer" style="margin-top:16px">${ICON.pin}구글 지도로 ${walking ? '걷는' : '대중교통'} 길 보기</a>` : '<p class="hint">아직 위치를 아는 곳이 없어요. 아래에서 정보를 찾으면 코스를 짤 수 있어요.</p>'}
    ${unknown.length ? `<p class="hint" style="margin-top:16px">위치를 몰라서 빠진 곳: ${unknown.map((u) => esc(u.name)).join(', ')} — 장소를 눌러 정보를 찾거나 '정보 없는 곳 찾기'를 눌러 주세요.</p>` : ''}
    <p class="hint">위치는 AI가 찾은 대략 좌표라 실제 길과 다를 수 있어요. 가기 전에 휴관일을 한 번 더 확인하세요.</p>`);
  sheetBody().querySelectorAll('[data-v]').forEach((b) => (b.onclick = () => openVenue(b.dataset.v)));
}

/* ── 보고 싶은 전시 ── */
function dday(ends) {
  if (!ends) return null;
  const end = new Date(`${ends}T23:59:59`);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.floor((end - today) / 86400000);
}

function wishSection() {
  if (!state.wish.length) return '';
  const list = [...state.wish].sort((a, b) => a.done - b.done || (dday(a.ends) ?? 9999) - (dday(b.ends) ?? 9999));
  return `<section class="wish-box">
    <h3 class="quest-area">보고 싶은 전시 <span>${state.wish.filter((w) => !w.done).length}</span></h3>
    <ul class="quest-list">${list.map((w) => {
      const d = dday(w.ends);
      const tag = w.done ? '<em class="dday seen">봤어요</em>' : d == null ? '' : d < 0 ? '<em class="dday over">끝남</em>' : `<em class="dday ${d <= 7 ? 'soon' : ''}">${d === 0 ? '오늘 끝' : `D-${d}`}</em>`;
      return `<li class="${w.done ? 'ok' : ''}">
        <button class="quest-check wish-check" data-id="${w.id}" type="button" aria-label="봤어요">${w.done ? '<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>' : ''}</button>
        <button class="quest-main wish-venue" data-v="${esc(w.venue)}" type="button"><strong>${esc(w.title)} ${tag}</strong><span>${esc([w.venue, w.period].filter(Boolean).join(' · '))}</span></button>
        ${state.todoEditing ? `<button class="quest-del wish-del" data-id="${w.id}" type="button" aria-label="빼기">${ICON.x}</button>` : ''}
      </li>`;
    }).join('')}</ul>
  </section>`;
}

async function toggleTodo(t) {
  try {
    const { place } = await api(`/api/todo/${t.id}`, { method: 'PUT', body: { done: !t.done } });
    state.todo = state.todo.map((x) => (x.id === t.id ? place : x));
    renderTodo();
    renderHero();
    if (place.done) toast(`${place.name} 다녀옴!`);
  } catch (err) { toast(err.message); }
}

async function removeTodo(t) {
  try {
    await api(`/api/todo/${t.id}`, { method: 'DELETE' });
    state.todo = state.todo.filter((x) => x.id !== t.id);
    renderTodo();
    renderHero();
  } catch (err) { toast(err.message); }
}

async function addTodoPlace(e) {
  e.preventDefault();
  const name = $('#todoName').value.trim();
  if (!name) return toast('장소 이름을 적어 주세요');
  needLogin(async () => {
    try {
      const { place } = await api('/api/todo', { method: 'POST', body: { name, area: $('#todoArea').value.trim() } });
      state.todo.push(place);
      $('#todoName').value = '';
      renderTodo();
      renderHero();
      toast('가볼 곳에 더했어요');
    } catch (err) { toast(err.message); }
  });
}

function setCat(c) {
  state.cat = c;
  renderCatTabs();
  renderGrid();
}

// 전시관 탭에서는 다녀온 전시관을 단추로 보여주고, 누르면 전시관 정보 팝업이 뜹니다.
function renderVenueRow() {
  const row = $('#venueRow');
  const count = new Map();
  state.items.filter((i) => i.category === 'exhibition' && i.place).forEach((i) => count.set(i.place, (count.get(i.place) || 0) + 1));
  row.hidden = state.cat !== 'exhibition' || !count.size;
  row.innerHTML = `<span class="venue-row-label">다녀온 전시관</span>` + [...count.entries()].sort((a, b) => b[1] - a[1])
    .map(([n, c]) => `<button class="venue-chip" data-v="${esc(n)}" type="button">${ICON.pin}${esc(n)}<b>${c}</b></button>`).join('');
  row.querySelectorAll('.venue-chip').forEach((b) => (b.onclick = () => openVenue(b.dataset.v)));
}

function renderCatTabs() {
  renderVenueRow();
  renderArtistKeys();
  const box = $('#catTabs');
  const n = (c) => state.items.filter((it) => !c || it.category === c).length;
  box.innerHTML = [['', '전체'], ...CATS].map(([k, label], i) =>
    `<button class="cat-tab ${state.cat === k ? 'on' : ''}" data-cat="${k}" role="tab" aria-selected="${state.cat === k}" title="키보드 ${i}">${label}<span class="cat-n">${state.loaded ? n(k) : ''}</span></button>`
  ).join('');
  box.querySelectorAll('.cat-tab').forEach((b) => (b.onclick = () => setCat(b.dataset.cat)));
}

function allTags() {
  const count = new Map();
  state.items.forEach((it) => it.tags.forEach((t) => count.set(t, (count.get(t) || 0) + 1)));
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'));
}

function renderTagChips() {
  const tags = allTags();
  const box = $('#tagChips');
  box.hidden = !tags.length;
  box.innerHTML =
    `<button class="chip ${state.tags.size ? '' : 'on'}" data-tag="">전체</button>` +
    tags.map(([t]) => `<button class="chip ${state.tags.has(t) ? 'on' : ''}" data-tag="${esc(t)}">#${esc(t)}</button>`).join('');
  box.querySelectorAll('.chip').forEach((b) => (b.onclick = () => {
    const t = b.dataset.tag;
    if (!t) state.tags.clear();
    else state.tags.has(t) ? state.tags.delete(t) : state.tags.add(t);
    renderTagChips();
    renderGrid();
  }));
}

// 작가 키맵: 분류 탭 아래 작가 단추 줄. 누르면 그 작가만, 한 번 더 누르면 해제. 대표작 그림(없으면 내 사진)을 얼굴로.
function renderArtistKeys() {
  const row = $('#artistKeys');
  if (!row) return;
  const count = new Map();
  state.items.filter((i) => i.artist && (!state.cat || i.category === state.cat)).forEach((i) => count.set(i.artist, (count.get(i.artist) || 0) + 1));
  if (state.artist && !count.has(state.artist)) count.set(state.artist, 0);
  row.hidden = !count.size;
  const names = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'));
  row.innerHTML = names.map(([n, c]) => `
    <button type="button" class="artist-key ${state.artist === n ? 'on' : ''}" data-v="${esc(n)}" role="tab" aria-selected="${state.artist === n}">
      <span class="ak-face">${artistThumb(n)}</span>
      <span class="ak-name">${esc(n)}</span><span class="ak-n">${c}</span>
    </button>`).join('') +
    (state.artist ? `<button type="button" class="artist-key more" id="akOpen"><span class="ak-face">›</span><span class="ak-name">작가 보기</span></button>` : '');
  row.querySelectorAll('.artist-key[data-v]').forEach((b) => (b.onclick = () => {
    state.artist = state.artist === b.dataset.v ? '' : b.dataset.v;
    renderFilterLabels();
    renderGrid();
  }));
  if ($('#akOpen')) $('#akOpen').onclick = () => go(`#/artist/${encodeURIComponent(state.artist)}`);
  // 다시 그려도 고른 작가가 화면 안에 보이도록 (세로로는 움직이지 않음)
  const on = row.querySelector('.artist-key.on');
  if (on && (on.offsetLeft < row.scrollLeft || on.offsetLeft + on.offsetWidth > row.scrollLeft + row.clientWidth)) row.scrollLeft = on.offsetLeft - 8;
}

function renderFilterLabels() {
  renderArtistKeys();
  $('#artistFilterLabel').textContent = state.artist || '모든 작가';
  $('#artistFilterBtn').classList.toggle('on', !!state.artist);
  $('#sortLabel').textContent = SORTS[state.sort];
  $('#viewModeLabel').textContent = state.mode === 'grid' ? '목록으로' : '사진으로';
}

function pickArtist() {
  const names = state.artists;
  openSheet(`
    <h2>작가 고르기</h2>
    <ul class="options">
      <li><button data-v="" class="${state.artist ? '' : 'on'}">모든 작가 <span class="n">${state.items.length}</span></button></li>
      ${names.map((a) => `<li><button data-v="${esc(a.name)}" class="${state.artist === a.name ? 'on' : ''}">${esc(a.name)} <span class="n">${a.count}</span></button></li>`).join('')}
    </ul>`);
  sheetBody().querySelectorAll('[data-v]').forEach((b) => (b.onclick = () => {
    state.artist = b.dataset.v;
    closeSheet();
    renderFilterLabels();
    renderGrid();
  }));
}

function pickSort() {
  openSheet(`<h2>정렬</h2><ul class="options">${Object.entries(SORTS)
    .map(([k, v]) => `<li><button data-v="${k}" class="${state.sort === k ? 'on' : ''}">${v}</button></li>`).join('')}</ul>`);
  sheetBody().querySelectorAll('[data-v]').forEach((b) => (b.onclick = () => {
    state.sort = b.dataset.v;
    closeSheet();
    renderFilterLabels();
    renderGrid();
  }));
}

/* ─────────────── 카드 목록 ─────────────── */

function cardHtml(it) {
  const img = it.images[0];
  const media = img
    ? `<div class="item-media"><img class="item-img" src="/img/${img}" alt="" loading="lazy" decoding="async" />${it.images.length > 1 ? `<span class="item-count">${it.images.length}</span>` : ''}</div>`
    : `<div class="item-media"><div class="item-noimg">${esc(it.memo || it.title)}</div></div>`;
  return `<button class="item" data-id="${it.id}">
    ${media}
    <div class="item-meta">
      ${it.title ? `<p class="item-title">${esc(it.title)}</p>` : ''}
      ${it.artist || !state.cat ? `<div class="item-artist">${[state.cat ? '' : catLabel(it.category), it.artist].filter(Boolean).map(esc).join(' · ')}</div>` : ''}
      ${it.memo ? `<div class="item-memo">${esc(it.memo)}</div>` : ''}
      <div class="item-sub">${[it.place, fmtDate(seenAt(it))].filter(Boolean).map(esc).join(' · ')}</div>
    </div>
  </button>`;
}

function bindCards(root) {
  root.querySelectorAll('.item').forEach((b) => (b.onclick = () => openDetail(b.dataset.id)));
}

function renderSkeleton() {
  $('#grid').innerHTML = [180, 240, 140, 220, 260, 160].map((h) => `<div class="skeleton" style="height:${h}px"></div>`).join('');
}

function renderGrid() {
  if (!state.loaded) return;
  const list = filtered();
  const grid = $('#grid');
  grid.classList.toggle('rows', state.mode === 'rows');
  grid.innerHTML = list.map(cardHtml).join('');
  bindCards(grid);

  const anyFilter = state.q.trim() || state.artist || state.tags.size;
  const scope = state.cat ? catLabel(state.cat) : '전체';
  $('#resultCount').textContent = state.items.length ? (anyFilter ? `${scope}에서 ${list.length}개 찾음` : `${scope} ${list.length}개`) : '';

  const empty = $('#empty');
  empty.hidden = list.length > 0;
  if (!state.items.length) {
    empty.innerHTML = `<strong>아직 모아둔 레퍼런스가 없어요</strong>마음에 드는 사진과 생각을 하나씩 모아보세요.<br><button class="btn" id="emptyAdd">첫 레퍼런스 추가하기</button>`;
    $('#emptyAdd').onclick = () => $('#addBtn').click();
  } else if (!list.length) {
    empty.innerHTML = `<strong>찾는 레퍼런스가 없어요</strong>다른 말로 찾거나 필터를 풀어보세요.<br><button class="btn ghost" id="emptyReset">필터 모두 풀기</button>`;
    $('#emptyReset').onclick = resetFilters;
  }
}

/* ─────────────── 작가 ─────────────── */

function artistThumb(name) {
  const it = state.items.find((i) => i.artist === name && i.images.length);
  const work = state.artists.find((a) => a.name === name)?.works?.find((w) => w.image);
  const key = it?.images[0] || work?.image;
  return key ? `<img src="/img/${key}" alt="" loading="lazy" />` : esc(name.slice(0, 1));
}

function renderArtists() {
  const q = state.artistQ.trim().toLowerCase();
  const list = state.artists.filter((a) => !q || a.name.toLowerCase().includes(q) || (/^[ㄱ-ㅎ]+$/.test(q) && choseong(a.name).includes(q)));
  $('#artistList').innerHTML = list.map((a) => `
    <li><button data-name="${esc(a.name)}">
      <div class="avatar">${artistThumb(a.name)}</div>
      <div class="list-main">
        <div class="list-title">${esc(a.name)}</div>
        <div class="list-sub">${a.description ? esc(a.description.split('\n')[0]) : '아직 소개가 없어요'}</div>
        ${a.works?.length ? `<div class="list-works">${a.works.map((w) => (w.image ? `<img src="/img/${w.image}" alt="" loading="lazy" />` : '')).join('')}<span>대표작 ${esc(a.works.map((w) => w.titleKo || w.title).join(' · '))}</span></div>` : ''}
      </div>
      <span class="list-count">${a.count}</span>
    </button></li>`).join('');
  $('#artistList').querySelectorAll('button').forEach((b) => (b.onclick = () => go(`#/artist/${encodeURIComponent(b.dataset.name)}`)));
  renderAutoBox();
  const empty = $('#artistEmpty');
  empty.hidden = list.length > 0;
  empty.innerHTML = state.artists.length
    ? '<strong>찾는 작가가 없어요</strong>'
    : '<strong>아직 작가가 없어요</strong>레퍼런스를 추가할 때 작가 이름을 적으면<br>여기에 작가별로 모입니다.';
}

function renderArtistPage(name) {
  if (!state.loaded) return;
  const a = state.artists.find((x) => x.name === name) || { name, count: 0, description: '', sources: [] };
  const works = state.items.filter((i) => i.artist === name).sort((x, y) => y.createdAt - x.createdAt);
  $('#artistAvatar').innerHTML = artistThumb(name);
  $('#artistName').textContent = name;
  $('#artistCount').textContent = `레퍼런스 ${works.length}개`;

  const text = $('#aiText');
  text.textContent = a.description || '아직 소개가 없어요. "AI로 설명 만들기"를 누르면 구글 AI가 이 작가를 간단히 소개해 줍니다.';
  text.classList.toggle('muted', !a.description);
  $('#aiBadge').textContent = a.description ? (a.byAi ? 'AI가 쓴 소개' : '직접 쓴 소개') : '작가 소개';
  $('#aiBtn').textContent = a.description && a.byAi ? '다시 만들기' : 'AI로 설명 만들기';
  $('#aiSources').innerHTML = (a.sources || []).map((s) => `<li><a href="${esc(s.uri)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a></li>`).join('');
  $('#aiNote').textContent = a.byAi ? 'AI 설명은 틀릴 수 있어요. 중요한 내용은 출처에서 꼭 확인하세요.' : '';
  renderWorks(a);
  showAiEdit(false);

  $('#aiBtn').onclick = () => (state.loggedIn ? runAi(name) : openLogin(() => runAi(name)));
  $('#aiEditBtn').onclick = () => (state.loggedIn ? startAiEdit(a) : openLogin(() => startAiEdit(a)));

  const grid = $('#artistGrid');
  grid.innerHTML = works.map(cardHtml).join('');
  bindCards(grid);
}

/* ─────────────── 작가 대표작 2점 (그림) ─────────────── */

function renderWorks(a) {
  const box = $('#aiWorks');
  const works = a.works || [];
  if (!works.length) {
    box.innerHTML = a.description ? '' : '<p class="hint">새 작가는 저장하면 AI가 소개와 대표작 그림을 자동으로 찾아요. 잠시 뒤 다시 열어 보세요.</p>';
    return;
  }
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  box.innerHTML = `<h4 class="works-title">대표작</h4><div class="works-grid">${works.map((w, n) => `
    <figure class="work">
      <button type="button" class="work-img" data-n="${n}" aria-label="크게 보기">${w.image ? `<img src="/img/${w.image}" alt="${esc(w.titleKo || w.title)}" loading="lazy" />` : `<span>그림을 못 찾았어요</span>`}</button>
      <figcaption>
        <strong>${esc(w.titleKo || w.title)}</strong>
        ${w.titleKo && w.title && w.titleKo !== w.title ? `<em>${esc(w.title)}</em>` : ''}
        <small>${esc([w.year, w.note].filter(Boolean).join(' · '))}</small>
        <span class="work-links">
          ${w.imageFrom ? `<a href="${esc(w.page || w.imageFrom)}" target="_blank" rel="noopener noreferrer">출처 ${esc(host(w.page || w.imageFrom))}</a>` : w.page ? `<a href="${esc(w.page)}" target="_blank" rel="noopener noreferrer">${esc(host(w.page))}</a>` : ''}
          <a href="https://www.google.com/search?tbm=isch&q=${encodeURIComponent(`${a.name} ${w.title || w.titleKo}`)}" target="_blank" rel="noopener noreferrer">구글 이미지</a>
          <button type="button" class="work-photo" data-n="${n}">${w.image ? '그림 바꾸기' : '그림 넣기'}</button>
        </span>
      </figcaption>
    </figure>`).join('')}</div>
    <p class="hint">그림은 웹에서 찾아 저장한 것이라 작품과 다를 수 있어요. 저작권은 작가에게 있어요.</p>`;
  box.querySelectorAll('.work-img').forEach((b) => (b.onclick = () => {
    const w = works[Number(b.dataset.n)];
    if (w.image) { $('#viewerImg').src = `/img/${w.image}`; $('#viewer').hidden = false; }
  }));
  box.querySelectorAll('.work-photo').forEach((b) => (b.onclick = () => needLogin(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setBusy(b, true);
      try {
        const blob = await resizeImage(file);
        const { key } = await api('/api/images', { method: 'POST', raw: blob, type: blob.type });
        const next = works.map((w, i) => (i === Number(b.dataset.n) ? { ...w, image: key, imageFrom: '' } : w));
        const r = await api(`/api/artists/${encodeURIComponent(a.name)}/works`, { method: 'PUT', body: { works: next } });
        a.works = r.works;
        await refreshArtists();
        toast('대표작 그림을 바꿨어요');
      } catch (err) { toast(err.message); setBusy(b, false); }
    };
    input.click();
  })));
}

// 작가 소개·대표작 자동 채우기: 매일 GitHub Actions 가 비어 있는 작가를 채우고, 여기서 지금 바로 돌릴 수도 있어요.
let autoRun = null;
function renderAutoBox() {
  const box = $('#autoBox');
  if (!box) return;
  const empty = state.artists.filter((a) => !a.description || !a.works?.length).length;
  if (!state.artists.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="auto-card">
      <div><strong>${ICON.spark}소개·대표작 자동 채우기</strong>
      <p>${autoRun ? esc(autoRun) : empty ? `비어 있는 작가 ${empty}명 · 매일 새벽 자동으로 채워요` : '모든 작가에 소개와 대표작이 있어요'}</p></div>
      ${empty && !autoRun ? '<button class="btn small" id="autoNow" type="button">지금 채우기</button>' : ''}
    </div>`;
  if ($('#autoNow')) $('#autoNow').onclick = () => needLogin(runAuto);
}

async function runAuto() {
  let n = 0;
  autoRun = '작가를 찾는 중…';
  renderAutoBox();
  try {
    for (;;) {
      const r = await api('/api/artists/auto', { method: 'POST' });
      if (!r.done) break;
      n++;
      await refreshArtists();
      if (!r.remaining) break;
      // 무료 한도(분당 5회)를 지키려고 한 명씩 16초 쉬어요
      for (let s = 16; s > 0; s--) { autoRun = `${r.done} 채웠어요 · 남은 ${r.remaining}명 · ${s}초 뒤 다음`; renderAutoBox(); await new Promise((ok) => setTimeout(ok, 1000)); }
    }
    toast(n ? `작가 ${n}명을 채웠어요` : '채울 작가가 없어요');
  } catch (err) { toast(err.message); }
  autoRun = null;
  await refreshArtists();
  loadStats();
}

function showAiEdit(on) {
  $('#aiEdit').hidden = !on;
  $('#aiEditActions').hidden = !on;
  $('#aiText').hidden = on;
  $('#aiSources').hidden = on;
}

function startAiEdit(a) {
  showAiEdit(true);
  const ta = $('#aiEdit');
  ta.value = a.description || '';
  ta.focus();
  $('#aiEditCancel').onclick = () => showAiEdit(false);
  $('#aiEditSave').onclick = async () => {
    setBusy($('#aiEditSave'), true);
    try {
      await api(`/api/artists/${encodeURIComponent(a.name)}`, { method: 'PUT', body: { description: ta.value } });
      await refreshArtists();
      toast('저장했어요');
    } catch (err) {
      toast(err.message);
    }
    setBusy($('#aiEditSave'), false);
  };
}

async function runAi(name) {
  const btn = $('#aiBtn');
  setBusy(btn, true);
  $('#aiText').textContent = '구글 AI가 작가를 찾아보고 있어요… (10초쯤 걸려요)';
  $('#aiText').classList.add('muted');
  try {
    await api(`/api/artists/${encodeURIComponent(name)}/ai`, { method: 'POST' });
    await refreshArtists();
    loadStats();
    toast('작가 소개를 만들었어요');
  } catch (err) {
    toast(err.message);
    renderArtistPage(name);
  }
  setBusy(btn, false);
}

async function refreshArtists() {
  const b = await api('/api/artists');
  state.artists = b.artists;
  renderAll();
}

/* ─────────────── 상세 ─────────────── */

function openDetail(id) {
  const it = state.items.find((i) => i.id === id);
  if (!it) return;
  const imgs = it.images;
  openSheet(`
    ${imgs.length ? `<div class="carousel ${imgs.length > 1 ? 'multi' : ''}" id="carousel">${imgs.map((k) => `<img src="/img/${k}" alt="" />`).join('')}</div>
      ${imgs.length > 1 ? `<div class="dots" id="dots">1 / ${imgs.length}</div>` : ''}` : ''}
    <span class="detail-cat">${catLabel(it.category)}</span>
    ${it.title ? `<h2 class="detail-title">${esc(it.title)}</h2>` : '<div style="height:8px"></div>'}
    ${it.artist ? `<button class="detail-artist" id="dArtist">${esc(it.artist)} ${ICON.chevron}</button>` : ''}
    ${it.place ? (it.category === 'exhibition'
      ? `<button class="detail-place venue-link" id="dPlace" type="button"><span>${PLACE.exhibition[0]}</span>${ICON.pin}${esc(it.place)} <em>운영시간 · 지금 하는 전시 ${ICON.chevron}</em></button>`
      : `<p class="detail-place"><span>${PLACE[it.category]?.[0] || '장소'}</span>${esc(it.place)}</p>`) : ''}
    ${it.memo ? `<p class="detail-memo">${esc(it.memo)}</p>` : ''}
    ${it.tags.length ? `<div class="detail-tags">${it.tags.map((t) => `<button data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}</div>` : ''}
    ${it.source ? (/^https?:\/\//i.test(it.source)
      ? `<a class="detail-source" href="${esc(it.source)}" target="_blank" rel="noopener noreferrer">출처 · ${esc(it.source)}</a>`
      : `<span class="detail-source">출처 · ${esc(it.source)}</span>`) : ''}
    <p class="detail-date">${it.visitedAt ? `관람 ${fmtDate(it.visitedAt)} · ` : ''}작성 ${fmtDate(it.createdAt)}${it.updatedAt !== it.createdAt ? ` · 수정 ${fmtDate(it.updatedAt)}` : ''}</p>
    ${imgs.length ? '<button class="btn ghost block" id="dMove" type="button" style="margin-top:16px">사진을 다른 항목으로 옮기기</button>' : ''}
    <div class="btn-row detail-actions">
      <button class="btn danger" id="dDel">삭제</button>
      <button class="btn" id="dEdit">수정하기</button>
    </div>`);

  const car = $('#carousel');
  if (car) {
    car.querySelectorAll('img').forEach((img) => (img.onclick = () => { $('#viewerImg').src = img.src; $('#viewer').hidden = false; }));
    if (imgs.length > 1) car.addEventListener('scroll', () => {
      const i = Math.round(car.scrollLeft / (car.firstElementChild.offsetWidth + 8));
      $('#dots').textContent = `${Math.min(i + 1, imgs.length)} / ${imgs.length}`;
    }, { passive: true });
  }
  if ($('#dPlace')) $('#dPlace').onclick = () => openVenue(it.place);
  if ($('#dMove')) $('#dMove').onclick = () => needLogin(() => openMove(it));
  if ($('#dArtist')) $('#dArtist').onclick = async () => { await closeSheet(); go(`#/artist/${encodeURIComponent(it.artist)}`); };
  sheetBody().querySelectorAll('[data-tag]').forEach((b) => (b.onclick = async () => {
    await closeSheet();
    state.tags = new Set([b.dataset.tag]);
    state.artist = '';
    go('#/');
    renderAll();
  }));
  $('#dEdit').onclick = () => (state.loggedIn ? openEditor(it) : openLogin(() => openEditor(it)));
  $('#dDel').onclick = () => (state.loggedIn ? confirmDelete(it) : openLogin(() => confirmDelete(it)));
}

function confirmDelete(it) {
  openSheet(`
    <h2>이 레퍼런스를 지울까요?</h2>
    <p style="color:var(--text-2);margin:-8px 0 24px">사진과 메모가 모두 지워지고 되돌릴 수 없어요.</p>
    <div class="btn-row"><button class="btn ghost" id="no">취소</button><button class="btn" style="background:var(--red)" id="yes">지우기</button></div>`);
  $('#no').onclick = () => closeSheet();
  $('#yes').onclick = async () => {
    setBusy($('#yes'), true);
    try {
      await api(`/api/items/${it.id}`, { method: 'DELETE' });
      state.items = state.items.filter((i) => i.id !== it.id);
      closeSheet();
      await refreshArtists();
      toast('지웠어요');
    } catch (err) {
      toast(err.message);
      setBusy($('#yes'), false);
    }
  };
}

/* ─────────────── 추가 · 수정 ─────────────── */

function openEditor(it = null) {
  const draft = {
    images: it ? [...it.images] : [],
    tags: it ? [...it.tags] : [],
    category: it?.category || state.cat || 'exhibition',
    catTouched: !!it, // 사람이 분류를 직접 골랐으면 AI가 바꾸지 않음
    autoDone: !!it, // 새 레퍼런스는 첫 사진을 올리면 AI가 한 번 자동으로 채움
    newKeys: [], // 이번에 새로 올린 사진 (취소하면 지움)
    uploading: 0,
  };
  const artistNames = state.artists.map((a) => a.name);

  openSheet(`
    <h2>${it ? '레퍼런스 수정' : '새 레퍼런스'}</h2>
    <form class="form" id="editForm" autocomplete="off">
      <div>
        <div class="label-row"><span class="label">사진</span><button type="button" class="ai-fill" id="aiFill" hidden>${ICON.spark}사진으로 채우기</button></div>
        <div class="photos" id="photos"></div>
        <input type="file" id="fileInput" accept="image/*" multiple hidden />
        <p class="ai-hint" id="aiHint" hidden></p>
      </div>
      <div>
        <span class="label">분류</span>
        <div class="seg-big" id="fCat" role="radiogroup">${CATS.map(([k, label]) => `<button type="button" role="radio" data-cat="${k}">${label}</button>`).join('')}</div>
      </div>
      <div>
        <label class="label" for="fPlace" id="fPlaceLabel">전시관 이름</label>
        <input class="field" id="fPlace" maxlength="100" list="placeNames" value="${esc(it?.place || '')}" />
        <label class="label" for="fSeen" style="margin-top:14px">관람일 <span class="hint" style="font-weight:500">사진 찍은 날이 있으면 자동으로 채워져요</span></label>
        <input class="field" id="fSeen" type="date" value="${it?.visitedAt ? ymd(it.visitedAt) : ''}" max="${ymd(Date.now())}" />
        <datalist id="placeNames">${[...new Set(state.items.map((x) => x.place).filter(Boolean))].map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist>
      </div>
      <div>
        <label class="label" for="fTitle">제목</label>
        <input class="field" id="fTitle" maxlength="200" placeholder="예) 따뜻한 조명의 카페 입구" value="${esc(it?.title || '')}" />
      </div>
      <div>
        <label class="label" for="fArtist">작가</label>
        <input class="field" id="fArtist" maxlength="100" list="artistNames" placeholder="예) 제임스 터렐" value="${esc(it?.artist || '')}" />
        <datalist id="artistNames">${artistNames.map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist>
      </div>
      <div>
        <label class="label" for="fMemo">메모</label>
        <textarea class="field" id="fMemo" maxlength="10000" rows="5" placeholder="왜 좋았는지, 어디에 써먹을지 적어두세요">${esc(it?.memo || '')}</textarea>
      </div>
      <div>
        <label class="label" for="fTag">태그</label>
        <div class="tag-input" id="tagBox"><input id="fTag" placeholder="입력 후 엔터 (예: 조명)" maxlength="40" enterkeyhint="done" /></div>
        <p class="hint">쉼표(,)나 엔터로 여러 개 넣을 수 있어요</p>
      </div>
      <div>
        <label class="label" for="fSource">출처 (선택)</label>
        <input class="field" id="fSource" maxlength="1000" placeholder="링크나 책 이름" value="${esc(it?.source || '')}" inputmode="url" />
      </div>
      <div class="btn-row">
        <button class="btn ghost" type="button" id="fCancel">취소</button>
        <button class="btn" type="submit" id="fSave">${it ? '저장' : '추가하기'}</button>
      </div>
    </form>`, { onClose: () => cleanupDraft(draft) });

  const renderPhotos = () => {
    $('#photos').innerHTML =
      draft.images.map((k, i) => `<div class="photo ${k.startsWith('blob:') ? 'uploading' : ''}">
        <img src="${k.startsWith('blob:') ? k : `/img/${k}`}" alt="" />
        ${k.startsWith('blob:') ? '' : `<button type="button" class="photo-del" data-i="${i}" aria-label="사진 빼기">${ICON.x}</button>`}
      </div>`).join('') +
      `<button type="button" class="photo-add" id="photoAdd">${ICON.camera}<span>${draft.images.length ? '더 넣기' : '사진 넣기'}</span></button>`;
    $('#photoAdd').onclick = () => $('#fileInput').click();
    $('#photos').querySelectorAll('.photo-del').forEach((b) => (b.onclick = () => {
      draft.images.splice(Number(b.dataset.i), 1);
      renderPhotos();
    }));
  };
  renderPhotos();

  const renderCat = () => {
    $('#fCat').querySelectorAll('button').forEach((b) => {
      const on = b.dataset.cat === draft.category;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on);
    });
    const [label, ph] = PLACE[draft.category];
    $('#fPlaceLabel').textContent = label;
    $('#fPlace').placeholder = ph;
  };
  $('#fCat').querySelectorAll('button').forEach((b) => (b.onclick = () => { draft.category = b.dataset.cat; draft.catTouched = true; renderCat(); }));
  renderCat();

  $('#fileInput').onchange = async (e) => {
    const files = [...e.target.files].slice(0, 60 - draft.images.length);
    e.target.value = '';
    // 관람일이 비어 있으면 첫 사진의 찍은 날로 채웁니다.
    if (!$('#fSeen').value && files[0]) photoDate(files[0]).then((d) => { if (d && $('#fSeen') && !$('#fSeen').value) $('#fSeen').value = d.slice(0, 10); });
    await Promise.all(files.map(async (file) => {
      const preview = URL.createObjectURL(file);
      draft.images.push(preview);
      draft.uploading++;
      renderPhotos();
      try {
        const blob = await resizeImage(file);
        const { key } = await api('/api/images', { method: 'POST', raw: blob, type: blob.type });
        draft.newKeys.push(key);
        draft.images[draft.images.indexOf(preview)] = key;
      } catch (err) {
        draft.images.splice(draft.images.indexOf(preview), 1);
        toast(err.message || '사진을 올리지 못했어요');
      }
      URL.revokeObjectURL(preview);
      draft.uploading--;
      renderPhotos();
    }));
    if (!draft.autoDone && firstPhoto()) { draft.autoDone = true; runAutoFill(); }
  };

  // ── AI 자동 채우기: 첫 사진을 보고 분류·제목·작가·전시관·태그를 채웁니다. 이미 적은 칸은 건드리지 않습니다.
  const firstPhoto = () => draft.images.find((k) => !k.startsWith('blob:'));
  const hint = (text) => { $('#aiHint').hidden = !text; $('#aiHint').textContent = text || ''; };
  const runAutoFill = async (force = false) => {
    const key = firstPhoto();
    if (!key) return;
    $('#aiFill').disabled = true;
    hint('AI가 사진을 보고 분류하는 중이에요…');
    try {
      // 큰 사진 대신 긴 변 768px 미리보기를 보내 토큰을 아낍니다.
      let thumb = '';
      try { thumb = await blobToBase64(await resizeImage(await (await fetch(`/img/${key}`)).blob(), 768)); } catch { /* 없으면 서버가 원본 사용 */ }
      const { suggestion: s } = await api('/api/analyze', { method: 'POST', body: { image: key, thumb, force } });
      if (!$('#editForm')) return; // 그사이 창을 닫았으면 그만
      const filled = [];
      const put = (id, v, name) => { const el = $(id); if (v && (force || !el.value.trim())) { el.value = v; filled.push(name); } };
      if (!draft.catTouched || force) { draft.category = s.category; renderCat(); filled.push(`분류(${catLabel(s.category)})`); }
      put('#fTitle', s.title, '제목');
      put('#fArtist', s.artist, '작가');
      put('#fPlace', s.place, PLACE[draft.category][0]);
      put('#fMemo', s.memo, '메모');
      const before = draft.tags.length;
      if (s.tags?.length) addTags(s.tags.join(','));
      if (draft.tags.length > before) filled.push('태그');
      loadStats();
      hint(filled.length ? `AI가 채웠어요: ${filled.join(', ')}. 틀리면 고쳐 주세요.` : 'AI가 더 채울 것을 찾지 못했어요.');
      // 같은 관람 항목이 이미 있으면 거기에 합칠 수 있게 단추를 보여줍니다.
      const same = !it && findSameViewing({ category: draft.category, title: $('#fTitle').value, place: $('#fPlace').value });
      if (same) {
        const box = $('#aiHint');
        box.insertAdjacentHTML('beforeend', `<span class="ai-merge-line">같은 관람 같아요: "${esc(same.title)}" (사진 ${same.images.length}장)</span><button type="button" class="btn small" id="mergeBtn">그 항목에 사진 합치기</button>`);
        $('#mergeBtn').onclick = async () => {
          setBusy($('#mergeBtn'), true);
          try {
            const body = {
              ...same,
              images: [...same.images, ...draft.images.filter((k) => !k.startsWith('blob:'))].slice(0, 20),
              tags: [...new Set([...same.tags, ...draft.tags])].slice(0, 30),
              memo: [same.memo, $('#fMemo').value.trim()].filter(Boolean).join('\n'),
            };
            const { item } = await api(`/api/items/${same.id}`, { method: 'PUT', body });
            state.items = state.items.map((x) => (x.id === same.id ? item : x));
            draft.newKeys = []; // 합쳤으니 지우지 않음
            await closeSheet();
            renderAll();
            toast(`"${item.title}"에 사진을 합쳤어요`);
          } catch (err) {
            toast(err.message);
            setBusy($('#mergeBtn'), false);
          }
        };
      }
    } catch (err) {
      hint(`AI 자동 채우기를 못 했어요: ${err.message}`);
    }
    $('#aiFill').disabled = false;
  };
  const showAiFill = () => { $('#aiFill').hidden = !firstPhoto(); };
  $('#aiFill').onclick = () => runAutoFill(true);
  new MutationObserver(showAiFill).observe($('#photos'), { childList: true });
  showAiFill();

  const renderTags = () => {
    const box = $('#tagBox');
    box.querySelectorAll('.tag').forEach((n) => n.remove());
    const input = $('#fTag');
    draft.tags.forEach((t, i) => {
      const span = document.createElement('span');
      span.className = 'tag';
      span.innerHTML = `#${esc(t)}<button type="button" aria-label="태그 빼기">${ICON.x}</button>`;
      span.querySelector('button').onclick = () => { draft.tags.splice(i, 1); renderTags(); };
      box.insertBefore(span, input);
    });
  };
  const addTags = (text) => {
    text.split(/[,，#\n]/).map((s) => s.trim()).filter(Boolean).forEach((t) => {
      if (!draft.tags.includes(t) && draft.tags.length < 30) draft.tags.push(t.slice(0, 40));
    });
    renderTags();
  };
  renderTags();
  const tagInput = $('#fTag');
  tagInput.addEventListener('keydown', (e) => {
    if (e.isComposing) return; // 한글 조합 중에는 엔터를 무시 (마지막 글자 두 번 들어가는 문제 방지)
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTags(tagInput.value); tagInput.value = ''; }
    else if (e.key === 'Backspace' && !tagInput.value && draft.tags.length) { draft.tags.pop(); renderTags(); }
  });
  tagInput.addEventListener('blur', () => { if (tagInput.value.trim()) { addTags(tagInput.value); tagInput.value = ''; } });

  $('#fCancel').onclick = () => closeSheet();
  $('#editForm').onsubmit = async (e) => {
    e.preventDefault();
    if (tagInput.value.trim()) { addTags(tagInput.value); tagInput.value = ''; }
    if (draft.uploading) return toast('사진을 올리는 중이에요. 잠시만 기다려 주세요');
    const body = {
      category: draft.category,
      place: $('#fPlace').value,
      visitedAt: toDayMs($('#fSeen').value),
      title: $('#fTitle').value,
      artist: $('#fArtist').value,
      memo: $('#fMemo').value,
      source: $('#fSource').value,
      tags: draft.tags,
      images: draft.images,
    };
    if (!body.title.trim() && !body.memo.trim() && !body.images.length) return toast('제목, 사진, 메모 중 하나는 넣어 주세요');
    setBusy($('#fSave'), true);
    try {
      const res = it
        ? await api(`/api/items/${it.id}`, { method: 'PUT', body })
        : await api('/api/items', { method: 'POST', body });
      draft.newKeys = []; // 저장했으니 지우지 않음
      if (it) state.items = state.items.map((x) => (x.id === it.id ? res.item : x));
      else state.items.unshift(res.item);
      closeSheet();
      await refreshArtists();
      toast(it ? '수정했어요' : '추가했어요');
    } catch (err) {
      toast(err.message);
      setBusy($('#fSave'), false);
    }
  };
}

/* ─────────────── 추가 방법 고르기 · 여러 장 한꺼번에 ─────────────── */

function openAddChoice() {
  openSheet(`
    <h2>어떻게 넣을까요?</h2>
    <div class="choice-list">
      <button class="choice" id="chBulk" type="button">
        <span class="choice-ic">${ICON.stack}</span>
        <span><strong>사진 여러 장 한꺼번에</strong><small>AI가 같은 전시·같은 영화 사진끼리 한 항목으로 묶고, 전시관·영화·그 외로 나눠 저장해요</small></span>
      </button>
      <button class="choice" id="chOne" type="button">
        <span class="choice-ic">${ICON.pencil}</span>
        <span><strong>하나씩 자세히 넣기</strong><small>사진을 넣으면 AI가 먼저 채워 주고, 직접 고칠 수 있어요</small></span>
      </button>
    </div>
    <input type="file" id="bulkInput" accept="image/*" multiple hidden />`);
  $('#chOne').onclick = () => openEditor();
  $('#chBulk').onclick = () => $('#bulkInput').click();
  $('#bulkInput').onchange = (e) => {
    const files = [...e.target.files].slice(0, 30);
    e.target.value = '';
    if (files.length) runBulk(files);
  };
}

// 같은 관람(같은 전시·같은 영화)인지 비교할 때 띄어쓰기·기호·대소문자는 무시합니다.
const keyOf = (v) => String(v || '').toLowerCase().normalize('NFC').replace(/[\s.\-_·'"()\[\]<>《》「」:]/g, '');

// 이미 있는 항목 중 같은 관람을 찾습니다: 분류와 제목(전시 이름·영화 제목)이 같고, 전시관 이름이 둘 다 있으면 그것도 같아야 함.
function findSameViewing(g, exceptId = '') {
  const t = keyOf(g.title);
  if (!t) return null;
  return state.items.find((it) => it.id !== exceptId && it.category === g.category && keyOf(it.title) === t &&
    (!g.place || !it.place || keyOf(it.place) === keyOf(g.place))) || null;
}

// JPEG 사진 속 찍은 날짜(EXIF)를 읽습니다. 없으면 ''. 같은 날 찍은 사진을 묶는 데 참고합니다.
async function photoDate(file) {
  try {
    const buf = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    if (buf.getUint16(0) !== 0xffd8) return '';
    let off = 2;
    while (off + 4 < buf.byteLength) {
      const marker = buf.getUint16(off);
      const size = buf.getUint16(off + 2);
      if (marker === 0xffe1 && buf.getUint32(off + 4) === 0x45786966) { // "Exif"
        const tiff = off + 10;
        const le = buf.getUint16(tiff) === 0x4949;
        const u16 = (o) => buf.getUint16(tiff + o, le);
        const u32 = (o) => buf.getUint32(tiff + o, le);
        const readStr = (o, n) => { let r = ''; for (let i = 0; i < n - 1; i++) r += String.fromCharCode(buf.getUint8(tiff + o + i)); return r; };
        const find = (ifd, tag) => {
          const n = u16(ifd);
          for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (u16(e) === tag) return e; }
          return -1;
        };
        const ifd0 = u32(4);
        const exifPtr = find(ifd0, 0x8769);
        let e = exifPtr >= 0 ? find(u32(exifPtr + 8), 0x9003) : -1; // 찍은 날짜
        if (e < 0) e = find(ifd0, 0x0132); // 없으면 파일 날짜
        if (e < 0) return '';
        const v = readStr(u32(e + 8), 20); // "2026:10:12 14:03:22"
        return /^\d{4}:\d\d:\d\d \d\d:\d\d/.test(v) ? `${v.slice(0, 4)}-${v.slice(5, 7)}-${v.slice(8, 10)} ${v.slice(11, 16)}` : '';
      }
      if ((marker & 0xff00) !== 0xff00) break;
      off += 2 + size;
    }
  } catch { /* 날짜 없음 */ }
  return '';
}

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
  fr.onerror = reject;
  fr.readAsDataURL(blob);
});

// AI가 묶지 못하면: 같은 날 찍은 사진끼리 한 항목 (날짜를 모르면 한 장씩)
function groupByDay(photos) {
  const byDay = new Map();
  photos.forEach((p, i) => {
    const day = p.date ? p.date.slice(0, 10) : `x${i}`;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(i);
  });
  return [...byDay.entries()].map(([day, idx]) => ({
    photos: idx, category: 'etc', title: day.startsWith('x') ? '' : `${day.replace(/-/g, '.')} 사진`,
    artist: '', place: '', tags: [], memo: '',
  }));
}

// 여러 장 한꺼번에: ① 사진 올리기 ② AI가 같은 관람끼리 묶기 ③ 묶음마다 하나의 항목으로 저장 (같은 관람 항목이 이미 있으면 거기에 더함)
async function runBulk(files) {
  const photos = files.map((f) => ({ file: f, url: URL.createObjectURL(f), key: null, date: '', thumb: '' }));
  let stop = false;
  openSheet(`
    <h2>사진 ${files.length}장 정리하기</h2>
    <p class="bulk-step" id="bulkStep">사진 올리는 중… 0/${files.length}</p>
    <div class="bulk-thumbs" id="bulkThumbs">${photos.map((p, i) => `<img src="${p.url}" alt="" data-i="${i}" />`).join('')}</div>
    <ul class="bulk-list" id="bulkList"></ul>
    <p class="hint" id="bulkSum"></p>
    <div class="btn-row" style="margin-top:16px"><button class="btn ghost" type="button" id="bulkStop">그만하기</button></div>`,
  { onClose: () => { stop = true; photos.forEach((p) => URL.revokeObjectURL(p.url)); } });
  const step = (t) => { if ($('#bulkStep')) $('#bulkStep').textContent = t; };
  $('#bulkStop').onclick = () => closeSheet();

  // ① 올리기 (한 번에 3장씩)
  let done = 0;
  const queue = [...photos];
  await Promise.all([0, 1, 2].map(async () => {
    while (queue.length && !stop) {
      const p = queue.shift();
      try {
        p.date = await photoDate(p.file);
        const [big, small] = await Promise.all([resizeImage(p.file), resizeImage(p.file, 640)]);
        p.thumb = await blobToBase64(small);
        p.smallBlob = small;
        ({ key: p.key } = await api('/api/images', { method: 'POST', raw: big, type: big.type }));
      } catch (err) {
        p.error = err.message || '올리지 못했어요';
        $(`#bulkThumbs img[data-i="${photos.indexOf(p)}"]`)?.classList.add('fail');
      }
      step(`사진 올리는 중… ${++done}/${files.length}`);
    }
  }));
  const ok = photos.filter((p) => p.key);
  if (stop) { ok.forEach((p) => api(`/api/images/${p.key}`, { method: 'DELETE' }).catch(() => {})); return; }
  if (!ok.length) { step('사진을 하나도 올리지 못했어요.'); $('#bulkStop').textContent = '닫기'; return; }

  // ② 같은 관람끼리 묶기
  step('AI가 같은 전시·같은 영화끼리 묶는 중…');
  let groups;
  let aiNote = '';
  try {
    ({ groups } = await api('/api/group', { method: 'POST', body: { photos: ok.map((p) => ({ data: p.thumb, date: p.date, blob: p.smallBlob })) } }));
  } catch (err) {
    groups = groupByDay(ok);
    aiNote = `AI로 묶지 못해서 찍은 날짜끼리 묶었어요 (${err.message})`;
  }
  if (stop) { ok.forEach((p) => api(`/api/images/${p.key}`, { method: 'DELETE' }).catch(() => {})); return; }

  // ③ 묶음마다 저장
  const rows = groups.map((g) => ({ g, state: 'wait', text: '' }));
  const draw = () => {
    const list = $('#bulkList');
    if (!list) return;
    list.innerHTML = rows.map((r) => `<li class="bulk-row ${r.state}">
      <img src="${ok[r.g.photos[0]].url}" alt="" />
      <div class="bulk-main"><strong>${esc(r.g.title || '제목 없음')} <em>${r.g.photos.length}장</em></strong><span>${esc(r.text || [catLabel(r.g.category), r.g.artist, r.g.place].filter(Boolean).join(' · '))}</span></div>
      ${r.state === 'work' ? '<i class="spin"></i>' : ''}
    </li>`).join('');
  };
  step(`${groups.length}개 항목으로 묶었어요. 저장하는 중…`);
  draw();
  let added = 0; let merged = 0; let failed = 0;
  for (const r of rows) {
    if (stop) break;
    r.state = 'work'; draw();
    const g = r.g;
    const keys = g.photos.map((i) => ok[i].key);
    try {
      const same = findSameViewing(g);
      if (same) {
        // 같은 관람 항목이 이미 있으면 사진과 태그만 더합니다. (이미 적어 둔 글은 그대로)
        const body = {
          ...same,
          images: [...same.images, ...keys].slice(0, 60),
          tags: [...new Set([...same.tags, ...(g.tags || [])])].slice(0, 30),
          artist: same.artist || g.artist, place: same.place || g.place,
        };
        const { item } = await api(`/api/items/${same.id}`, { method: 'PUT', body });
        state.items = state.items.map((x) => (x.id === same.id ? item : x));
        r.text = `이미 있던 항목에 ${keys.length}장 더함`;
        merged++;
      } else {
        const dates = g.photos.map((i) => ok[i].date).filter(Boolean).sort();
        const body = { category: g.category, title: g.title || (ok[g.photos[0]].file.name.replace(/\.[^.]+$/, '')), artist: g.artist, place: g.place, memo: g.memo, tags: g.tags, images: keys, source: '', visitedAt: dates.length ? toDayMs(dates[0].slice(0, 10)) : 0 };
        const { item } = await api('/api/items', { method: 'POST', body });
        state.items.unshift(item);
        g.artist = item.artist;
        r.text = '';
        added++;
      }
      r.state = 'done';
    } catch (err) {
      failed++;
      r.state = 'fail';
      r.text = err.message || '저장하지 못했어요';
      keys.forEach((k) => api(`/api/images/${k}`, { method: 'DELETE' }).catch(() => {}));
    }
    draw();
    renderAll();
  }
  await refreshArtists().catch(() => {});
  loadStats();
  const msg = [added && `새 항목 ${added}개`, merged && `기존 항목에 더함 ${merged}개`, failed && `실패 ${failed}개`].filter(Boolean).join(' · ') || '저장한 것 없음';
  step(`다 됐어요: 사진 ${ok.length}장 → ${msg}`);
  if ($('#bulkSum')) $('#bulkSum').textContent = (aiNote ? `${aiNote}. ` : '') + '잘못 묶였으면 항목을 눌러 사진을 빼거나 고쳐 주세요.';
  if ($('#bulkStop')) $('#bulkStop').textContent = '닫기';
  toast(`정리했어요 (${msg})`);
}

function cleanupDraft(draft) {
  // 올렸지만 저장하지 않은 사진은 지웁니다.
  draft.newKeys.forEach((k) => api(`/api/images/${k}`, { method: 'DELETE' }).catch(() => {}));
  draft.newKeys = [];
}

/* ─────────────── 로그인 ─────────────── */

function openLogin(after) {
  openSheet(`
    <h2>비밀번호를 입력해 주세요</h2>
    <p style="color:var(--text-2);margin:-8px 0 20px">추가 · 수정 · 삭제 · AI 설명은 로그인한 뒤에 할 수 있어요.</p>
    <form class="form" id="loginForm">
      <input class="field" id="pw" type="password" autocomplete="current-password" placeholder="비밀번호" required />
      <button class="btn block" id="pwBtn" type="submit">로그인</button>
    </form>`);
  setTimeout(() => $('#pw')?.focus(), 250);
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    setBusy($('#pwBtn'), true);
    try {
      await api('/api/login', { method: 'POST', body: { password: $('#pw').value } });
      state.loggedIn = true;
      renderAuth();
      await closeSheet();
      toast('로그인했어요');
      if (after) after();
    } catch (err) {
      toast(err.message);
      setBusy($('#pwBtn'), false);
      $('#pw').select();
    }
  };
}

async function logoutFlow() {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  state.loggedIn = false;
  renderAuth();
  toast('로그아웃했어요');
}

/* ─────────────── 기타 ─────────────── */

function localGet(k) { try { return localStorage.getItem(`ref:${k}`); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem(`ref:${k}`, v); } catch { /* 저장 안 되는 브라우저 */ } }
