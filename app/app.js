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
    const [a, b, c] = await Promise.all([api('/api/items'), api('/api/artists'), api('/api/todo').catch(() => ({ todo: [] }))]);
    state.items = a.items;
    state.artists = b.artists;
    state.todo = c.todo || [];
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

// [이만큼 다녀오면, 칭호]. 마지막 칭호 뒤로는 20번마다 ★ 레벨이 오릅니다.
const LEVELS = [
  [0, '전시 새싹'], [1, '첫 관람객'], [3, '산책하는 관람객'], [6, '전시 탐험가'], [10, '단골 관람객'],
  [15, '작품 수집가'], [22, '큐레이터 견습생'], [30, '갤러리 마스터'], [45, '아트 순례자'], [60, '전설의 관람객'],
];

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

// 방문 횟수 세기: 같은 전시관에 같은 날 올린 항목들은 한 번 다녀온 것으로 칩니다.
// 전시관 이름이 없는 항목은 그날 다녀온 전시관(가장 많이 올린 곳)에 붙이고, 그날 전시관이 하나도 없으면 그날 하루를 한 번으로 칩니다.
// (사진을 여러 항목으로 나눠 올려도 방문 횟수가 부풀지 않도록)
function uniqueVisits(items) {
  const byDay = new Map();
  for (const i of items) {
    const day = fmtDate(i.createdAt);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(i);
  }
  const out = [];
  for (const [day, list] of byDay) {
    const venues = new Map();
    const loose = [];
    for (const i of list) {
      const k = keyOf(i.place);
      if (!k) { loose.push(i); continue; }
      if (!venues.has(k)) venues.set(k, { key: `${k}|${day}`, place: i.place, at: 0, items: [] });
      venues.get(k).items.push(i);
    }
    if (loose.length) {
      const top = [...venues.values()].sort((a, b) => b.items.length - a.items.length)[0];
      if (top) top.items.push(...loose);
      else venues.set('', { key: `?|${day}`, place: '', at: 0, items: loose });
    }
    for (const v of venues.values()) { v.at = Math.max(...v.items.map((i) => i.createdAt)); out.push(v); }
  }
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

  box.innerHTML = `
    <div class="hero-top">
      <div class="lv-badge"><small>Lv.</small>${L.lv}</div>
      <div class="hero-title"><span>전시 레벨</span><strong>${esc(L.title)}</strong></div>
      <button class="hero-visits" id="visitsBtn" type="button"><b>${state.loaded ? visits : '-'}</b><small>번 다녀옴 ›</small></button>
    </div>
    <div class="bar xp" role="progressbar" aria-label="다음 레벨까지" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>
    <p class="bar-caption">다음 레벨 <b>${esc(L.nextTitle)}</b>까지 전시 ${L.to - visits}번</p>
    <div class="hero-chips">
      ${state.todo.length ? `<button type="button" class="quest-chip" id="questChip">${ICON.pin}가볼 곳 <b>${todoProgress().done}/${state.todo.length}</b></button>` : ''}
      <span>이번 달 전시 <b>${monthVisits}</b></span><span>영화 <b>${movies}</b></span><span>작가 <b>${state.artists.length}</b></span>
    </div>
    <button class="energy" id="energyBtn" type="button">
      <span class="energy-head"><span class="energy-label">${ICON.spark}AI 에너지${isClaude ? ' (Claude)' : ''}</span><b>${enPct == null ? '한도 미정' : `${enPct}%`}</b></span>
      <span class="bar energy-bar ${enLevel}"><i style="width:${enPct == null ? 100 : enPct}%"></i></span>
      <span class="bar-caption">${esc(aiCaption)}</span>
    </button>`;
  $('#energyBtn').onclick = openEnergy;
  $('#visitsBtn').onclick = openVisits;
  if ($('#questChip')) $('#questChip').onclick = () => go('#/todo');

  // 레벨 업 축하 (지난번 본 레벨보다 오르면 한 번)
  if (state.loaded) {
    const seen = Number(localGet('lv') || 0);
    if (seen && L.lv > seen) {
      toast(`레벨 업! Lv.${L.lv} ${L.title}`);
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
    <p class="hint" style="margin:-8px 0 16px;line-height:1.6">전시 항목 ${exItems.length}개를 <b>같은 날 · 같은 전시관</b>끼리 묶어서 한 번으로 셌어요. 전시관 이름이 없는 항목은 그날 다녀온 전시관에 붙였어요.</p>
    <ul class="visit-list">${visits.map((v) => `<li>
      <div class="visit-date">${fmtDate(v.at)}</div>
      <div class="visit-main">
        <strong>${esc(v.place || '전시관 이름 없음')}</strong>
        <span>${v.items.map((i) => esc(i.title || '제목 없음')).join(' · ')}</span>
      </div>
      <b class="visit-n">${v.items.length}개</b>
    </li>`).join('')}</ul>
    <p class="hint" style="margin-top:14px">잘못 묶였으면 그 항목을 열어 전시관 이름을 고쳐 주세요.</p>`);
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
      <button class="btn block" id="limSave" type="submit">저장</button>
    </form>`);
  $('#energyForm').onsubmit = async (e) => {
    e.preventDefault();
    setBusy($('#limSave'), true);
    try {
      const body = { aiDailyRequests: $('#limReq').value };
      if ($('#limTokens')) body.aiDailyTokens = $('#limTokens').value;
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
    .sort((a, b) => b.createdAt - a.createdAt);
  const head = `
    <h2 class="venue-title" id="vTitle">${esc(name)}</h2>
    <p class="venue-mine">${mine.length ? `내가 다녀온 기록 <b>${uniqueVisits(mine).length}번</b> · 마지막 ${fmtDate(mine[0].createdAt)}` : '아직 기록이 없어요'}</p>
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
      ${(i.exhibitions || []).length ? `<ul class="vex">${i.exhibitions.map((e) => `<li>
          <strong>${esc(e.title)}</strong>
          <span>${esc([e.period, e.artist].filter(Boolean).join(' · '))}</span>
          ${e.desc ? `<p>${esc(e.desc)}</p>` : ''}
        </li>`).join('')}</ul>` : '<p class="hint">진행 중인 전시를 확인하지 못했어요. 홈페이지에서 확인해 주세요.</p>'}
      ${i.notes ? `<p class="vnotes">${esc(i.notes)}</p>` : ''}
      ${(v.sources || []).length ? `<ul class="sources">${v.sources.map((s) => `<li><a href="${esc(s.uri)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a></li>`).join('')}</ul>` : ''}
      <p class="venue-foot">${fmtDate(v.updatedAt)}에 AI가 ${v.sources?.length ? '구글 검색으로 ' : ''}정리한 정보예요. 틀릴 수 있으니 가기 전에 홈페이지에서 꼭 확인하세요.</p>
      <button class="btn ghost block" id="vRefresh" type="button">${ICON.spark}정보 새로 찾기</button>`;
    $('#vRefresh').onclick = () => refresh();
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
      <h3 class="quest-area">${esc(area)} <span>${n}/${list.length}</span></h3>
      <ul class="quest-list">${list.map((t) => {
        const v = visitsOf(t);
        const ok = v.length || t.done;
        return `<li class="${ok ? 'ok' : ''}">
          <button class="quest-check" data-id="${t.id}" type="button" aria-label="${ok ? '다녀옴' : '아직'}" ${v.length ? 'disabled' : ''}>${ok ? '<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>' : ''}</button>
          <button class="quest-main" data-id="${t.id}" type="button">
            <strong>${esc(t.name)}</strong>
            <span>${v.length ? `다녀옴 ${v.length}번 · 마지막 ${fmtDate(Math.max(...v.map((x) => x.at)))}` : t.done ? '다녀옴 (직접 표시)' : '운영시간 · 지금 하는 전시 보기'}</span>
          </button>
          ${state.todoEditing ? `<button class="quest-del" data-id="${t.id}" type="button" aria-label="빼기">${ICON.x}</button>` : ICON.chevron}
        </li>`;
      }).join('')}</ul>
    </section>`;
  }).join('');
  const find = (el) => state.todo.find((t) => t.id === el.dataset.id);
  $('#todoGroups').querySelectorAll('.quest-main').forEach((b) => (b.onclick = () => { const t = find(b); openVenue(venueQuery(t.name), t.keys?.length ? t.keys : [t.name]); }));
  $('#todoGroups').querySelectorAll('.quest-check').forEach((b) => (b.onclick = () => needLogin(() => toggleTodo(find(b)))));
  $('#todoGroups').querySelectorAll('.quest-del').forEach((b) => (b.onclick = () => needLogin(() => removeTodo(find(b)))));
}

const needLogin = (fn) => (state.loggedIn ? fn() : openLogin(fn));

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

function renderFilterLabels() {
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
      <div class="item-sub">${[it.place, fmtDate(it.createdAt)].filter(Boolean).map(esc).join(' · ')}</div>
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
  return it ? `<img src="/img/${it.images[0]}" alt="" loading="lazy" />` : esc(name.slice(0, 1));
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
      </div>
      <span class="list-count">${a.count}</span>
    </button></li>`).join('');
  $('#artistList').querySelectorAll('button').forEach((b) => (b.onclick = () => go(`#/artist/${encodeURIComponent(b.dataset.name)}`)));
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
  showAiEdit(false);

  $('#aiBtn').onclick = () => (state.loggedIn ? runAi(name) : openLogin(() => runAi(name)));
  $('#aiEditBtn').onclick = () => (state.loggedIn ? startAiEdit(a) : openLogin(() => startAiEdit(a)));

  const grid = $('#artistGrid');
  grid.innerHTML = works.map(cardHtml).join('');
  bindCards(grid);
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
    <p class="detail-date">작성 ${fmtDate(it.createdAt)}${it.updatedAt !== it.createdAt ? ` · 수정 ${fmtDate(it.updatedAt)}` : ''}</p>
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
    const files = [...e.target.files].slice(0, 20 - draft.images.length);
    e.target.value = '';
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
      const { suggestion: s } = await api('/api/analyze', { method: 'POST', body: { image: key } });
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
          images: [...same.images, ...keys].slice(0, 20),
          tags: [...new Set([...same.tags, ...(g.tags || [])])].slice(0, 30),
          artist: same.artist || g.artist, place: same.place || g.place,
        };
        const { item } = await api(`/api/items/${same.id}`, { method: 'PUT', body });
        state.items = state.items.map((x) => (x.id === same.id ? item : x));
        r.text = `이미 있던 항목에 ${keys.length}장 더함`;
        merged++;
      } else {
        const body = { category: g.category, title: g.title || (ok[g.photos[0]].file.name.replace(/\.[^.]+$/, '')), artist: g.artist, place: g.place, memo: g.memo, tags: g.tags, images: keys, source: '' };
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
