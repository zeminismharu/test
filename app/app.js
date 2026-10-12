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
  const [session] = await Promise.all([api('/api/session').catch(() => ({})), loadAll()]);
  state.loggedIn = !!session.loggedIn;
  state.open = !!session.open;
  renderAuth();
  route();
}

async function loadAll() {
  try {
    const [a, b] = await Promise.all([api('/api/items'), api('/api/artists')]);
    state.items = a.items;
    state.artists = b.artists;
    state.loaded = true;
  } catch (err) {
    state.loaded = true;
    toast(err.message || '불러오지 못했습니다.');
  }
  renderAll();
}

function renderAll() {
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
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === (r.name === 'home' ? 'home' : 'artists')));
  if (r.name === 'artist') renderArtistPage(r.arg);
  window.scrollTo({ top: 0 });
}

window.addEventListener('hashchange', route);

function bindStatic() {
  $('#brand').onclick = () => { resetFilters(); go('#/'); };
  document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => go(t.dataset.tab === 'home' ? '#/' : '#/artists')));
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

function setCat(c) {
  state.cat = c;
  renderCatTabs();
  renderGrid();
}

function renderCatTabs() {
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
    ${it.place ? `<p class="detail-place"><span>${PLACE[it.category]?.[0] || '장소'}</span>${esc(it.place)}</p>` : ''}
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
      hint(filled.length ? `AI가 채웠어요: ${filled.join(', ')}. 틀리면 고쳐 주세요.` : 'AI가 더 채울 것을 찾지 못했어요.');
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
        <span><strong>사진 여러 장 한꺼번에</strong><small>AI가 장마다 전시관·영화·그 외로 나누고, 작가·제목·전시관 이름까지 채워서 따로 저장해요</small></span>
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

// 한 장씩 차례로: 사진 올리기 → AI 분석 → 레퍼런스로 저장. 앞에서 저장한 작가 이름을 뒤 사진이 이어받아 같은 작가로 모입니다.
async function runBulk(files) {
  const rows = files.map((f) => ({ file: f, url: URL.createObjectURL(f), state: 'wait', text: '기다리는 중' }));
  let stop = false;
  openSheet(`
    <h2>사진 ${files.length}장 정리하는 중</h2>
    <ul class="bulk-list" id="bulkList"></ul>
    <p class="hint" id="bulkSum"></p>
    <div class="btn-row" style="margin-top:16px"><button class="btn ghost" type="button" id="bulkStop">그만하기</button></div>`,
  { onClose: () => { stop = true; rows.forEach((r) => URL.revokeObjectURL(r.url)); } });
  const draw = () => {
    const list = $('#bulkList');
    if (!list) return;
    list.innerHTML = rows.map((r) => `<li class="bulk-row ${r.state}">
      <img src="${r.url}" alt="" />
      <div class="bulk-main"><strong>${esc(r.title || r.file.name)}</strong><span>${esc(r.text)}</span></div>
      ${r.state === 'work' ? '<i class="spin"></i>' : ''}
    </li>`).join('');
  };
  draw();
  $('#bulkStop').onclick = () => { stop = true; closeSheet(); };

  const counts = { exhibition: 0, movie: 0, etc: 0 };
  let failed = 0;
  for (const r of rows) {
    if (stop) break;
    r.state = 'work'; r.text = '사진 올리는 중'; draw();
    let key = null;
    try {
      const blob = await resizeImage(r.file);
      ({ key } = await api('/api/images', { method: 'POST', raw: blob, type: blob.type }));
      r.text = 'AI가 보는 중'; draw();
      let s = { category: 'etc', title: '', artist: '', place: '', tags: [], memo: '' };
      try {
        ({ suggestion: s } = await api('/api/analyze', { method: 'POST', body: { image: key } }));
      } catch (err) {
        r.note = `AI 분석 실패: ${err.message}`;
      }
      if (stop) { api(`/api/images/${key}`, { method: 'DELETE' }).catch(() => {}); break; }
      const body = {
        category: s.category, title: s.title || r.file.name.replace(/\.[^.]+$/, ''), artist: s.artist,
        place: s.place, memo: s.memo, tags: s.tags, images: [key], source: '',
      };
      const { item } = await api('/api/items', { method: 'POST', body });
      state.items.unshift(item);
      counts[item.category]++;
      r.state = 'done';
      r.title = item.title;
      r.text = r.note || [catLabel(item.category), item.artist, item.place].filter(Boolean).join(' · ');
    } catch (err) {
      failed++;
      r.state = 'fail';
      r.text = err.message || '저장하지 못했어요';
      if (key) api(`/api/images/${key}`, { method: 'DELETE' }).catch(() => {});
    }
    draw();
    renderAll();
  }
  await refreshArtists().catch(() => {});
  const sum = CATS.map(([k, l]) => (counts[k] ? `${l} ${counts[k]}` : '')).filter(Boolean).join(' · ');
  const msg = `${sum || '저장한 것 없음'}${failed ? ` · 실패 ${failed}` : ''}`;
  if ($('#bulkSum')) {
    $('#bulkSum').textContent = `다 됐어요: ${msg}. 틀린 건 카드를 눌러 고쳐 주세요.`;
    $('#bulkStop').textContent = '닫기';
  }
  toast(`나눠서 저장했어요 (${msg})`);
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
