// 관리 화면 — 작업 계획 보드
// 도화지(1600×1000) 위에 펜으로 그리고, 조명을 놓아 위치·색온도(K)·밝기를 정하고, 할 일과 메모를 적습니다.
// 바꿀 때마다 1초 뒤 자동 저장됩니다.

import { api, $, esc, toast, resizeImage, openSheet, closeSheet, sheetBody, setBusy, fmtDate } from './common.js';

const W = 1600;
const H = 1000;
const NS = 'http://www.w3.org/2000/svg';
const COLORS = ['#191f28', '#3182f6', '#f04452', '#ff9f0f', '#03b26c', '#8b95a1'];
const WIDTHS = [2, 4, 8]; // 화면에서 보이는 굵기(px)
const KINDS = {
  down: '다운라이트',
  spot: '스포트',
  pendant: '펜던트',
  line: '라인 조명',
  indirect: '간접 조명',
};
const KELVIN_PRESETS = [
  [2200, '촛불'],
  [2700, '전구색'],
  [3000, '웜화이트'],
  [4000, '주백색'],
  [5000, '주광'],
  [6500, '주광색'],
];

const ed = {
  board: null, // { id, title, data }
  tool: 'pen',
  color: COLORS[0],
  width: WIDTHS[1],
  selected: null, // { type: 'light'|'text'|'stroke', id }
  undo: [],
  redo: [],
  view: { x: 0, y: 0, w: W, h: H },
  saveTimer: null,
  saving: false,
  dirty: false,
  showGrid: true,
};

const svg = $('#board');
const stage = $('#stage');

/* ─────────────── 시작 · 로그인 ─────────────── */

init();

async function init() {
  const s = await api('/api/session').catch(() => ({}));
  if (s.loggedIn) showBoards();
  else showLogin();
  if (s.open) $('#logoutBtn').hidden = true; // 열린 모드에는 로그아웃이 필요 없음

  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    setBusy($('#pwBtn'), true);
    try {
      await api('/api/login', { method: 'POST', body: { password: $('#pw').value } });
      showBoards();
    } catch (err) {
      toast(err.message);
    }
    setBusy($('#pwBtn'), false);
  };
  $('#logoutBtn').onclick = async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    showLogin();
  };
  $('#newBoard').onclick = newBoard;
  bindEditor();
  window.addEventListener('hashchange', route);
}

function showLogin() {
  $('#loginBox').hidden = false;
  $('#boardsBox').hidden = true;
  $('#logoutBtn').hidden = true;
  setTimeout(() => $('#pw').focus(), 50);
}

async function showBoards() {
  $('#loginBox').hidden = true;
  $('#boardsBox').hidden = false;
  $('#logoutBtn').hidden = false;
  route();
}

async function route() {
  const id = location.hash.replace(/^#\/?/, '');
  if (id) return openBoard(id);
  await flushSave();
  $('#editorScreen').hidden = true;
  $('#listScreen').hidden = false;
  document.body.classList.remove('editing');
  loadBoards();
}

/* ─────────────── 보드 목록 ─────────────── */

async function loadBoards() {
  let boards = [];
  try {
    ({ boards } = await api('/api/boards'));
  } catch (err) {
    if (err.status === 401) return showLogin();
    toast(err.message);
  }
  $('#boardList').innerHTML = boards.length
    ? boards.map((b) => {
      const s = b.summary || {};
      return `<li><a class="board-item" href="#${b.id}">
        <div class="board-thumb">${s.bg ? `<img src="/img/${s.bg}" alt="" loading="lazy" />` : '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m3 15 5-5 4 4 3-3 6 6"/></svg>'}</div>
        <div class="board-main">
          <strong>${esc(b.title)}</strong>
          <span class="board-meta">조명 ${s.lights || 0}개 · 할 일 ${s.done || 0}/${s.todos || 0} · ${fmtDate(b.updatedAt)}</span>
          ${(s.kelvins || []).length ? `<span class="k-chips">${s.kelvins.map((k) => `<span class="k-chip"><i style="background:${kelvinColor(k)}"></i>${k}K</span>`).join('')}</span>` : ''}
        </div>
      </a></li>`;
    }).join('')
    : '<li class="panel-empty" style="padding:24px 4px">아직 계획이 없어요. 위의 "새 계획 만들기"를 눌러 시작하세요.</li>';
}

async function newBoard() {
  try {
    const { board } = await api('/api/boards', { method: 'POST', body: { title: `계획 ${fmtDate(Date.now())}` } });
    location.hash = board.id;
  } catch (err) {
    toast(err.message);
  }
}

/* ─────────────── 보드 열기 ─────────────── */

async function openBoard(id) {
  if (ed.board?.id === id && !$('#editorScreen').hidden) return;
  let board;
  try {
    ({ board } = await api(`/api/boards/${encodeURIComponent(id)}`));
  } catch (err) {
    toast(err.status === 401 ? '로그인이 필요해요' : err.message);
    location.hash = '';
    return;
  }
  const d = board.data || {};
  board.data = {
    v: 1,
    bg: d.bg || null,
    bgOpacity: d.bgOpacity ?? 1,
    ...(d.bgBox && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(d.bgBox[k])) ? { bgBox: d.bgBox } : {}),
    grid: d.grid ?? true,
    strokes: d.strokes || [],
    lights: d.lights || [],
    texts: d.texts || [],
    todos: d.todos || [],
    note: d.note || '',
  };
  ed.board = board;
  ed.selected = null;
  ed.undo = [];
  ed.redo = [];
  $('#listScreen').hidden = true;
  $('#editorScreen').hidden = false;
  document.body.classList.add('editing');
  $('#edTitle').value = board.title;
  $('#planNote').value = board.data.note;
  setSaveState('저장됨');
  renderAll();
  fitView();
  setTool(ed.tool);
}

/* ─────────────── 저장 ─────────────── */

function setSaveState(t) { $('#saveState').textContent = t; }

function scheduleSave() {
  ed.dirty = true;
  setSaveState('저장 중…');
  clearTimeout(ed.saveTimer);
  ed.saveTimer = setTimeout(save, 1000);
}

async function save() {
  clearTimeout(ed.saveTimer);
  if (!ed.board || !ed.dirty) return;
  if (ed.saving) { ed.saveTimer = setTimeout(save, 500); return; }
  ed.saving = true;
  ed.dirty = false;
  try {
    await api(`/api/boards/${ed.board.id}`, { method: 'PUT', body: { title: $('#edTitle').value, data: ed.board.data } });
    setSaveState(ed.dirty ? '저장 중…' : '저장됨');
  } catch (err) {
    ed.dirty = true;
    setSaveState('저장 안 됨');
    toast(err.status === 401 ? '로그인이 풀렸어요. 새로고침 후 다시 로그인해 주세요' : err.message);
  }
  ed.saving = false;
}

async function flushSave() {
  if (ed.dirty) await save();
}

window.addEventListener('beforeunload', (e) => {
  if (ed.dirty || ed.saving) {
    // 창을 닫는 중에도 마지막 내용을 보내 봅니다.
    if (ed.board && ed.dirty) {
      fetch(`/api/boards/${ed.board.id}`, {
        method: 'PUT', keepalive: true, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: $('#edTitle').value, data: ed.board.data }),
      }).catch(() => {});
    }
    e.preventDefault();
  }
});

/* ─────────────── 되돌리기 ─────────────── */

function snapshot() {
  const { strokes, lights, texts, bgBox, bgOpacity } = ed.board.data;
  return JSON.stringify({ strokes, lights, texts, bgBox: bgBox || null, bgOpacity });
}

// 바꾸기 "전"에 부릅니다.
function remember() {
  ed.undo.push(snapshot());
  if (ed.undo.length > 80) ed.undo.shift();
  ed.redo = [];
  updateUndoButtons();
}

function restore(snap) {
  Object.assign(ed.board.data, JSON.parse(snap));
  if (!ed.board.data.bgBox) delete ed.board.data.bgBox; // 도면 자리가 없던 때로 → 사진 비율에 맞춰 다시
  if (ed.selected && !findSelected()) ed.selected = null;
  renderAll();
  scheduleSave();
}

function doUndo() {
  if (!ed.undo.length) return;
  ed.redo.push(snapshot());
  restore(ed.undo.pop());
  updateUndoButtons();
}

function doRedo() {
  if (!ed.redo.length) return;
  ed.undo.push(snapshot());
  restore(ed.redo.pop());
  updateUndoButtons();
}

function updateUndoButtons() {
  $('#undoBtn').disabled = !ed.undo.length;
  $('#redoBtn').disabled = !ed.redo.length;
}

/* ─────────────── 색온도 → 색 ─────────────── */

// 색온도(K)를 화면에 보이는 대략의 색으로 바꿉니다 (Tanner Helland 근사식).
export function kelvinColor(k) {
  const t = Math.min(40000, Math.max(1000, k)) / 100;
  let r; let g; let b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const c = (v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function kelvinName(k) {
  if (k < 2500) return '촛불·호박색';
  if (k < 2900) return '전구색 (아늑함)';
  if (k < 3500) return '웜화이트 (따뜻함)';
  if (k < 4500) return '주백색 (자연스러움)';
  if (k < 5800) return '주광 (밝고 또렷함)';
  return '주광색 (차갑고 선명함)';
}

/* ─────────────── 그리기 (화면 갱신) ─────────────── */

function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

function pathD(pts) {
  if (pts.length < 4) return '';
  if (pts.length === 4 && pts[0] === pts[2] && pts[1] === pts[3]) return `M${pts[0]} ${pts[1]}l0.1 0`;
  // 점 사이를 부드러운 곡선으로 잇습니다.
  let d = `M${pts[0]} ${pts[1]}`;
  for (let i = 2; i < pts.length - 2; i += 2) {
    const mx = (pts[i] + pts[i + 2]) / 2;
    const my = (pts[i + 1] + pts[i + 3]) / 2;
    d += `Q${pts[i]} ${pts[i + 1]} ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  d += `L${pts[pts.length - 2]} ${pts[pts.length - 1]}`;
  return d;
}

/* ─────────────── 펜슬 필압: 세게 누르면 굵게 ─────────────── */
// 필압이 있는 선(pr = 점마다 0~1)은 굵기가 변하는 '채운 모양'으로 그립니다. 없는 선은 예전처럼 일정한 굵기.
const prWidth = (v) => 0.3 + 1.4 * Math.max(0, Math.min(1, v)); // 보통(0.5) = 정한 굵기
let usePressure = (() => { try { return localStorage.getItem('ref:pressure') !== '0'; } catch { return true; } })();

function outlineD(pts, pr, w) {
  const n = pts.length / 2;
  const P = (i) => [pts[i * 2], pts[i * 2 + 1]];
  const R = (i) => (w * prWidth(pr[Math.min(i, pr.length - 1)] ?? 0.5)) / 2;
  const f = (v) => v.toFixed(1);
  if (n === 1 || (n === 2 && pts[0] === pts[2] && pts[1] === pts[3])) {
    const [x, y] = P(0); const r = R(0);
    return `M${f(x - r)} ${f(y)}a${f(r)} ${f(r)} 0 1 0 ${f(r * 2)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-r * 2)} 0Z`;
  }
  const L = []; const Rt = [];
  for (let i = 0; i < n; i++) {
    const [ax, ay] = P(Math.max(0, i - 1)); const [bx, by] = P(Math.min(n - 1, i + 1));
    let tx = bx - ax; let ty = by - ay;
    const len = Math.hypot(tx, ty) || 1; tx /= len; ty /= len;
    const [x, y] = P(i); const r = R(i);
    L.push([x - ty * r, y + tx * r]); Rt.push([x + ty * r, y - tx * r]);
  }
  // 점 사이를 부드러운 곡선으로 (pathD 와 같은 방식)
  const smooth = (arr) => {
    let d = '';
    for (let i = 1; i < arr.length - 1; i++) d += `Q${f(arr[i][0])} ${f(arr[i][1])} ${f((arr[i][0] + arr[i + 1][0]) / 2)} ${f((arr[i][1] + arr[i + 1][1]) / 2)}`;
    return d + `L${f(arr[arr.length - 1][0])} ${f(arr[arr.length - 1][1])}`;
  };
  const rEnd = R(n - 1); const rStart = R(0);
  const back = Rt.slice().reverse();
  return `M${f(L[0][0])} ${f(L[0][1])}${smooth(L)}A${f(rEnd)} ${f(rEnd)} 0 0 1 ${f(back[0][0])} ${f(back[0][1])}${smooth(back)}A${f(rStart)} ${f(rStart)} 0 0 1 ${f(L[0][0])} ${f(L[0][1])}Z`;
}

function strokeAttrs(s) {
  return s.pr?.length
    ? { d: outlineD(s.pts, s.pr, s.w), fill: s.color, stroke: 'none' }
    : { d: pathD(s.pts), fill: 'none', stroke: s.color, 'stroke-width': s.w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
}

function renderAll() {
  renderBackground();
  renderStrokes();
  renderLights();
  renderTexts();
  renderSelection();
  renderPanel();
  updateUndoButtons();
}

// 도면(배경) 자리: bgBox = { x, y, w, h }. 처음엔 도화지(1600×1000)에 맞춰 가운데, 사진 비율 그대로.
const bgBoxOf = (d) => d.bgBox || { x: 0, y: 0, w: W, h: H };

function fitBgBox(d) {
  const key = d.bg;
  const im = new Image();
  im.onload = () => {
    if (ed.board?.data !== d || d.bg !== key || d.bgBox || !im.naturalWidth) return;
    const r = Math.min(W / im.naturalWidth, H / im.naturalHeight);
    const w = im.naturalWidth * r; const h = im.naturalHeight * r;
    d.bgBox = { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w: Math.round(w), h: Math.round(h) };
    renderBackground();
    renderSelection();
  };
  im.src = `/img/${key}`;
}

function renderBackground() {
  const d = ed.board.data;
  const img = $('#bgImage');
  if (d.bg) {
    img.setAttribute('href', `/img/${d.bg}`);
    img.setAttribute('visibility', 'visible');
    img.setAttribute('opacity', d.bgOpacity);
    const b = bgBoxOf(d);
    img.setAttribute('x', b.x); img.setAttribute('y', b.y); img.setAttribute('width', b.w); img.setAttribute('height', b.h);
    img.setAttribute('data-type', 'bg'); img.setAttribute('data-id', 'bg');
    if (!d.bgBox) fitBgBox(d);
  } else {
    img.removeAttribute('href');
    img.setAttribute('visibility', 'hidden');
  }
  $('#gridRect').setAttribute('visibility', d.grid ? 'visible' : 'hidden');
}

function renderStrokes() {
  const g = $('#layerStrokes');
  g.innerHTML = '';
  for (const s of ed.board.data.strokes) {
    el('path', { ...strokeAttrs(s), 'data-type': 'stroke', 'data-id': s.id }, g);
  }
}

function lightSize(l) { return l.size ?? 160; }

function renderLights(kOverride) {
  const k = kOverride ?? upp();
  const glow = $('#layerGlow');
  const g = $('#layerLights');
  glow.innerHTML = '';
  g.innerHTML = '';
  const defs = el('defs', {}, glow);

  for (const l of ed.board.data.lights) {
    const col = kelvinColor(l.k);
    const power = (l.power ?? 80) / 100;
    const r = lightSize(l);
    const ang = l.angle || 0;

    // 빛 퍼짐
    const gid = `glow-${l.id}`;
    const grad = el('radialGradient', { id: gid }, defs);
    el('stop', { offset: '0%', 'stop-color': col, 'stop-opacity': (0.75 * power).toFixed(2) }, grad);
    el('stop', { offset: '55%', 'stop-color': col, 'stop-opacity': (0.3 * power).toFixed(2) }, grad);
    el('stop', { offset: '100%', 'stop-color': col, 'stop-opacity': 0 }, grad);
    if (l.kind === 'spot') {
      // 한쪽으로 비추는 원뿔 모양
      const spread = 30 * Math.PI / 180;
      const a = (ang - 90) * Math.PI / 180;
      const p1 = [l.x + Math.cos(a - spread) * r * 1.4, l.y + Math.sin(a - spread) * r * 1.4];
      const p2 = [l.x + Math.cos(a + spread) * r * 1.4, l.y + Math.sin(a + spread) * r * 1.4];
      el('path', { d: `M${l.x} ${l.y}L${p1[0]} ${p1[1]}A${r * 1.4} ${r * 1.4} 0 0 1 ${p2[0]} ${p2[1]}Z`, fill: `url(#${gid})` }, glow);
    } else if (l.kind === 'line' || l.kind === 'indirect') {
      const len = l.len ?? 300;
      el('rect', {
        x: l.x - len / 2 - r * 0.5, y: l.y - r * 0.5, width: len + r, height: r,
        rx: r * 0.5, fill: col, opacity: (0.35 * power).toFixed(2), filter: 'url(#soft)',
        transform: `rotate(${ang} ${l.x} ${l.y})`,
      }, glow);
    } else {
      el('circle', { cx: l.x, cy: l.y, r, fill: `url(#${gid})` }, glow);
    }

    // 조명 기구 모양
    const grp = el('g', { 'data-type': 'light', 'data-id': l.id, class: 'light', transform: `translate(${l.x} ${l.y})` }, g);
    const glyph = el('g', { transform: `scale(${k})` }, grp);
    const stroke = '#191f28';
    if (l.kind === 'line' || l.kind === 'indirect') {
      // 길이는 실제 도화지 길이, 두께만 화면 기준
      const len = (l.len ?? 300) / k;
      el('rect', {
        x: -len / 2, y: -7, width: len, height: 14, rx: 7, fill: col, stroke, 'stroke-width': 2.5,
        'stroke-dasharray': l.kind === 'indirect' ? '10 6' : null, transform: `rotate(${ang})`,
      }, glyph);
    } else if (l.kind === 'pendant') {
      el('rect', { x: -13, y: -13, width: 26, height: 26, rx: 4, fill: col, stroke, 'stroke-width': 2.5, transform: 'rotate(45)' }, glyph);
    } else {
      el('circle', { r: 15, fill: col, stroke, 'stroke-width': 2.5 }, glyph);
      el('circle', { r: 5, fill: stroke }, glyph);
      if (l.kind === 'spot') el('path', { d: 'M0 -15L0 -30', stroke, 'stroke-width': 3, 'stroke-linecap': 'round', transform: `rotate(${ang})` }, glyph);
    }
    // 넉넉한 터치 영역
    el('circle', { r: 26, fill: 'transparent' }, glyph);

    // 이름표
    const label = `${l.name ? `${l.name} · ` : ''}${l.k}K · ${l.power ?? 80}%`;
    const ly = (l.kind === 'line' || l.kind === 'indirect') ? 30 : 42;
    const tw = label.length * 12 + 20;
    el('rect', { x: -tw / 2, y: ly - 18, width: tw, height: 28, rx: 14, fill: '#191f28', opacity: 0.86 }, glyph);
    const t = el('text', { x: 0, y: ly + 1, 'text-anchor': 'middle', 'font-size': 15, 'font-weight': 700, fill: '#fff', 'font-family': 'Pretendard Variable, Pretendard, sans-serif' }, glyph);
    t.textContent = label;
  }
}

function renderTexts() {
  const g = $('#layerTexts');
  g.innerHTML = '';
  for (const t of ed.board.data.texts) {
    const n = el('text', {
      x: t.x, y: t.y, fill: t.color, 'font-size': t.size, 'font-weight': 700,
      'font-family': 'Pretendard Variable, Pretendard, sans-serif', 'data-type': 'text', 'data-id': t.id,
      'dominant-baseline': 'hanging',
    }, g);
    String(t.text || '글자').split('\n').forEach((line, i) => {
      const s = el('tspan', { x: t.x, dy: i ? t.size * 1.3 : 0 }, n);
      s.textContent = line || ' ';
    });
  }
}

function findSelected() {
  const s = ed.selected;
  if (!s) return null;
  if (s.type === 'bg') return ed.board.data.bg ? bgBoxOf(ed.board.data) : null;
  const list = { light: ed.board.data.lights, text: ed.board.data.texts, stroke: ed.board.data.strokes }[s.type];
  return list?.find((x) => x.id === s.id) || null;
}

function renderSelection() {
  const g = $('#layerSelect');
  g.innerHTML = '';
  const s = ed.selected;
  if (!s) return;
  if (s.type === 'bg') {
    // 도면: 테두리 + 네 모서리 동그라미(끌면 크기, 비율은 그대로)
    if (!ed.board.data.bg) return;
    const b = bgBoxOf(ed.board.data);
    const u = upp();
    el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, fill: 'none', stroke: '#3182f6', 'stroke-width': 2.5 * u, 'stroke-dasharray': '10 7', 'pointer-events': 'none' }, g);
    for (const [id, cx, cy] of [['nw', b.x, b.y], ['ne', b.x + b.w, b.y], ['sw', b.x, b.y + b.h], ['se', b.x + b.w, b.y + b.h]]) {
      el('circle', { cx, cy, r: 22 * u, fill: 'transparent', 'data-type': 'bgHandle', 'data-id': id }, g); // 누르기 쉬운 큰 자리
      el('circle', { cx, cy, r: 9 * u, fill: '#fff', stroke: '#3182f6', 'stroke-width': 3 * u, 'pointer-events': 'none' }, g);
    }
    return;
  }
  const node = svg.querySelector(`[data-type="${s.type}"][data-id="${s.id}"]`);
  if (!node) return;
  const b = node.getBBox();
  let x = b.x; let y = b.y;
  if (s.type === 'light') { const l = findSelected(); x += l.x; y += l.y; }
  const pad = 8 * upp();
  el('rect', {
    x: x - pad, y: y - pad, width: b.width + pad * 2, height: b.height + pad * 2, rx: 10,
    fill: 'none', stroke: '#3182f6', 'stroke-width': 2.5 * upp(), 'stroke-dasharray': '8 6', 'pointer-events': 'none',
  }, g);
}

/* ─────────────── 오른쪽 패널 ─────────────── */

function renderPanel() {
  renderProps();
  renderLightList();
  renderTodos();
}

function renderLightList() {
  const lights = ed.board.data.lights;
  $('#lightCount').textContent = lights.length ? `${lights.length}` : '';
  $('#lightEmpty').hidden = lights.length > 0;
  $('#lightList').innerHTML = lights.map((l, i) => `
    <li><button data-id="${l.id}" class="${ed.selected?.id === l.id ? 'on' : ''}">
      <i class="k-dot" style="background:${kelvinColor(l.k)}"></i>
      <span class="ll-name">${esc(l.name || `조명 ${i + 1}`)}<small>${KINDS[l.kind] || KINDS.down}</small></span>
      <span class="ll-k">${l.k}K</span>
      <span class="ll-p">${l.power ?? 80}%</span>
    </button></li>`).join('');
  $('#lightList').querySelectorAll('button').forEach((b) => (b.onclick = () => select({ type: 'light', id: b.dataset.id })));
}

function renderTodos() {
  const todos = ed.board.data.todos;
  const done = todos.filter((t) => t.done).length;
  $('#todoCount').textContent = todos.length ? `${done}/${todos.length}` : '';
  const sorted = [...todos].sort((a, b) => (a.done - b.done) || ((a.date || '9999') < (b.date || '9999') ? -1 : (a.date || '9999') > (b.date || '9999') ? 1 : 0));
  $('#todoList').innerHTML = sorted.map((t) => `
    <li class="${t.done ? 'done' : ''}">
      <label><input type="checkbox" data-id="${t.id}" ${t.done ? 'checked' : ''} /><span class="check"></span></label>
      <div class="todo-main">
        <span class="todo-text" contenteditable="plaintext-only" data-id="${t.id}">${esc(t.text)}</span>
        ${t.date ? `<span class="todo-date ${!t.done && t.date < today() ? 'late' : ''}">${t.date.replace(/-/g, '.')}</span>` : ''}
      </div>
      <button class="todo-del" data-id="${t.id}" aria-label="지우기"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </li>`).join('');
  const list = $('#todoList');
  list.querySelectorAll('input[type=checkbox]').forEach((c) => (c.onchange = () => {
    const t = todos.find((x) => x.id === c.dataset.id);
    t.done = c.checked;
    renderTodos();
    scheduleSave();
  }));
  list.querySelectorAll('.todo-text').forEach((s) => (s.onblur = () => {
    const t = todos.find((x) => x.id === s.dataset.id);
    const v = s.textContent.trim().slice(0, 300);
    if (v && v !== t.text) { t.text = v; scheduleSave(); }
    else s.textContent = t.text;
  }));
  list.querySelectorAll('.todo-del').forEach((b) => (b.onclick = () => {
    ed.board.data.todos = todos.filter((x) => x.id !== b.dataset.id);
    renderTodos();
    scheduleSave();
  }));
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function renderProps() {
  const box = $('#propBox');
  const item = findSelected();
  if (!item) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  const type = ed.selected.type;

  if (type === 'bg') {
    const d = ed.board.data;
    box.innerHTML = `
      <div class="prop-head"><h3 class="panel-h">도면 · 배경</h3><button class="text-btn small" data-act="close">닫기</button></div>
      <p class="prop-hint">도면 가운데를 끌면 옮겨지고, 네 모서리 동그라미를 끌면 크기가 바뀌어요 (비율은 그대로).</p>
      <label class="prop"><span>진하기 <b data-out="bgOp">${Math.round((d.bgOpacity ?? 1) * 100)}%</b></span><input type="range" data-bg="op" min="10" max="100" step="5" value="${Math.round((d.bgOpacity ?? 1) * 100)}" /></label>
      <div class="btn-row"><button class="btn ghost small" data-act="bgReset">처음 크기로</button><button class="btn danger small" data-act="bgDel">도면 빼기</button></div>`;
    let rem = false;
    const op = box.querySelector('[data-bg="op"]');
    op.addEventListener('input', () => { if (!rem) { remember(); rem = true; } d.bgOpacity = Number(op.value) / 100; box.querySelector('[data-out="bgOp"]').textContent = `${op.value}%`; renderBackground(); });
    op.addEventListener('change', () => { rem = false; scheduleSave(); });
    box.querySelector('[data-act="close"]').onclick = () => select(null);
    box.querySelector('[data-act="bgReset"]').onclick = () => { remember(); delete d.bgBox; renderBackground(); renderSelection(); scheduleSave(); };
    box.querySelector('[data-act="bgDel"]').onclick = () => { remember(); d.bg = null; delete d.bgBox; select(null); renderBackground(); scheduleSave(); };
    return;
  }

  if (type === 'light') {
    const l = item;
    const showAngle = l.kind === 'spot' || l.kind === 'line' || l.kind === 'indirect';
    const showLen = l.kind === 'line' || l.kind === 'indirect';
    box.innerHTML = `
      <div class="prop-head"><h3 class="panel-h">선택한 조명</h3><button class="text-btn small" data-act="close">닫기</button></div>
      <div class="k-preview" style="--k:${kelvinColor(l.k)}"><strong>${l.k}K</strong><span>${kelvinName(l.k)}</span></div>
      <label class="prop"><span>이름</span><input class="field sm" data-f="name" maxlength="40" placeholder="예) 거실 메인" value="${esc(l.name || '')}" /></label>
      <div class="prop"><span>종류</span><div class="seg">${Object.entries(KINDS).map(([k, v]) => `<button data-kind="${k}" class="${(l.kind || 'down') === k ? 'on' : ''}">${v}</button>`).join('')}</div></div>
      <label class="prop"><span>색온도 <b data-out="k">${l.k}K</b></span>
        <input type="range" class="kelvin-range" data-f="k" min="1800" max="10000" step="50" value="${l.k}" /></label>
      <div class="k-presets">${KELVIN_PRESETS.map(([k, n]) => `<button data-k="${k}" class="${l.k === k ? 'on' : ''}"><i style="background:${kelvinColor(k)}"></i>${k}K<small>${n}</small></button>`).join('')}</div>
      <label class="prop"><span>밝기 <b data-out="power">${l.power ?? 80}%</b></span><input type="range" data-f="power" min="0" max="100" step="5" value="${l.power ?? 80}" /></label>
      <label class="prop"><span>빛 퍼짐 <b data-out="size">${lightSize(l)}</b></span><input type="range" data-f="size" min="30" max="600" step="10" value="${lightSize(l)}" /></label>
      ${showAngle ? `<label class="prop"><span>방향 <b data-out="angle">${l.angle || 0}°</b></span><input type="range" data-f="angle" min="0" max="355" step="5" value="${l.angle || 0}" /></label>` : ''}
      ${showLen ? `<label class="prop"><span>길이 <b data-out="len">${l.len ?? 300}</b></span><input type="range" data-f="len" min="40" max="1400" step="10" value="${l.len ?? 300}" /></label>` : ''}
      <label class="prop"><span>메모</span><textarea class="field sm" data-f="memo" rows="3" maxlength="1000" placeholder="제품명, 높이, 설치 방법, 가격 등">${esc(l.memo || '')}</textarea></label>
      <div class="btn-row"><button class="btn ghost small" data-act="dup">복제</button><button class="btn danger small" data-act="del">삭제</button></div>`;
  } else if (type === 'text') {
    const t = item;
    box.innerHTML = `
      <div class="prop-head"><h3 class="panel-h">선택한 글자</h3><button class="text-btn small" data-act="close">닫기</button></div>
      <label class="prop"><span>내용</span><textarea class="field sm" data-f="text" rows="3" maxlength="500">${esc(t.text)}</textarea></label>
      <label class="prop"><span>크기 <b data-out="size">${t.size}</b></span><input type="range" data-f="size" min="8" max="400" step="2" value="${t.size}" /></label>
      <div class="prop"><span>색</span><div class="swatches inline">${COLORS.map((c) => `<button data-color="${c}" class="${t.color === c ? 'on' : ''}" style="--c:${c}"></button>`).join('')}</div></div>
      <div class="btn-row"><button class="btn ghost small" data-act="dup">복제</button><button class="btn danger small" data-act="del">삭제</button></div>`;
  } else {
    box.innerHTML = `
      <div class="prop-head"><h3 class="panel-h">선택한 선</h3><button class="text-btn small" data-act="close">닫기</button></div>
      <div class="prop"><span>색</span><div class="swatches inline">${COLORS.map((c) => `<button data-color="${c}" class="${item.color === c ? 'on' : ''}" style="--c:${c}"></button>`).join('')}</div></div>
      <div class="btn-row"><button class="btn danger small" data-act="del">삭제</button></div>`;
  }

  // 입력값 바꾸기: 움직이는 동안은 화면만 바꾸고, 손을 뗄 때 되돌리기 기록을 남깁니다.
  let remembered = false;
  const startChange = () => { if (!remembered) { remember(); remembered = true; } };
  const endChange = () => { remembered = false; scheduleSave(); };

  box.querySelectorAll('[data-f]').forEach((inp) => {
    const f = inp.dataset.f;
    inp.addEventListener('input', () => {
      startChange();
      const v = inp.type === 'range' ? Number(inp.value) : inp.value;
      item[f] = v;
      const out = box.querySelector(`[data-out="${f}"]`);
      if (out) out.textContent = f === 'k' ? `${v}K` : f === 'power' ? `${v}%` : f === 'angle' ? `${v}°` : v;
      if (f === 'k') {
        const p = box.querySelector('.k-preview');
        p.style.setProperty('--k', kelvinColor(v));
        p.querySelector('strong').textContent = `${v}K`;
        p.querySelector('span').textContent = kelvinName(v);
        box.querySelectorAll('[data-k]').forEach((b) => b.classList.toggle('on', Number(b.dataset.k) === v));
      }
      redrawItem(type);
    });
    inp.addEventListener('change', endChange);
  });
  box.querySelectorAll('[data-k]').forEach((b) => (b.onclick = () => { remember(); item.k = Number(b.dataset.k); afterPropChange(type); }));
  box.querySelectorAll('[data-kind]').forEach((b) => (b.onclick = () => { remember(); item.kind = b.dataset.kind; afterPropChange(type); }));
  box.querySelectorAll('[data-color]').forEach((b) => (b.onclick = () => { remember(); item.color = b.dataset.color; afterPropChange(type); }));
  box.querySelector('[data-act="close"]').onclick = () => select(null);
  box.querySelector('[data-act="del"]').onclick = () => deleteSelected();
  const dup = box.querySelector('[data-act="dup"]');
  if (dup) dup.onclick = () => {
    remember();
    const copy = { ...item, id: uid(), x: item.x + 40, y: item.y + 40 };
    ed.board.data[type === 'light' ? 'lights' : 'texts'].push(copy);
    select({ type, id: copy.id });
    scheduleSave();
  };
}

function afterPropChange(type) {
  redrawItem(type);
  renderProps();
  scheduleSave();
}

function redrawItem(type) {
  if (type === 'light') { renderLights(); renderLightList(); } else if (type === 'text') renderTexts(); else renderStrokes();
  renderSelection();
}

function select(sel) {
  ed.selected = sel;
  renderSelection();
  renderProps();
  renderLightList();
  // 도면은 바로 끌어 옮길 수 있게 패널을 열지 않습니다 (좁은 화면에서 패널이 도면을 가림). 진하기 등은 패널 단추로.
  if (sel && sel.type !== 'bg') openPanel(true);
}

function deleteSelected() {
  const s = ed.selected;
  if (!s) return;
  remember();
  const key = { light: 'lights', text: 'texts', stroke: 'strokes' }[s.type];
  ed.board.data[key] = ed.board.data[key].filter((x) => x.id !== s.id);
  ed.selected = null;
  renderAll();
  scheduleSave();
}

/* ─────────────── 확대 · 이동 ─────────────── */

// 화면 1px 이 도화지에서 몇 칸인지. 조명 아이콘·이름표·펜 굵기는 확대해도 화면에서 같은 크기로 보이게 이걸 곱합니다.
function upp() {
  const r = svg.getBoundingClientRect();
  if (!r.width || !r.height) return 1;
  return Math.max(ed.view.w / r.width, ed.view.h / r.height);
}

function applyView() {
  const v = ed.view;
  svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
  if (ed.board) renderLights();
  renderSelection();
}

function contentBox() {
  const d = ed.board.data;
  let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
  const add = (ax, ay, bx, by) => { x1 = Math.min(x1, ax); y1 = Math.min(y1, ay); x2 = Math.max(x2, bx); y2 = Math.max(y2, by); };
  if (d.bg) { const b = bgBoxOf(d); add(b.x, b.y, b.x + b.w, b.y + b.h); }
  d.strokes.forEach((st) => { for (let i = 0; i < st.pts.length; i += 2) add(st.pts[i] - st.w, st.pts[i + 1] - st.w, st.pts[i] + st.w, st.pts[i + 1] + st.w); });
  d.lights.forEach((l) => { const r = Math.max(lightSize(l), (l.len ?? 0) / 2 + 40); add(l.x - r, l.y - r, l.x + r, l.y + r); });
  const tl = $('#layerTexts');
  if (d.texts.length && tl.getBBox) { const b = tl.getBBox(); add(b.x, b.y, b.x + b.width, b.y + b.height); }
  if (x1 === Infinity) return null;
  return { x: x1, y: y1, w: Math.max(x2 - x1, 200), h: Math.max(y2 - y1, 120) };
}

function fitView() {
  const b = ed.board && contentBox();
  if (!b) ed.view = { x: 0, y: 0, w: W, h: H };
  else {
    const pad = Math.max(b.w, b.h) * 0.08;
    ed.view = { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
  }
  applyView();
}

function zoomAt(factor, cx, cy) {
  const v = ed.view;
  const nw = Math.min(W * 20, Math.max(W / 20, v.w / factor));
  const k = nw / v.w;
  ed.view = { x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k, w: nw, h: v.h * k };
  applyView();
}

function toBoard(evt) {
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX;
  pt.y = evt.clientY;
  const p = pt.matrixTransform(svg.getScreenCTM().inverse());
  return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 };
}

/* ─────────────── 손가락 · 마우스 ─────────────── */

const pointers = new Map();
let gesture = null; // { kind: 'draw'|'move'|'pan'|'pinch'|'erase', ... }

function hitItem(evt) {
  const n = document.elementFromPoint(evt.clientX, evt.clientY)?.closest('[data-type]');
  if (!n || !svg.contains(n)) return null;
  return { type: n.dataset.type, id: n.dataset.id };
}

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax; const dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function eraseAt(p) {
  const d = ed.board.data;
  const tol = 14 * upp();
  const hitStroke = d.strokes.find((s) => {
    for (let i = 0; i < s.pts.length - 2; i += 2) {
      if (distToSeg(p.x, p.y, s.pts[i], s.pts[i + 1], s.pts[i + 2], s.pts[i + 3]) < tol + s.w / 2) return true;
    }
    return s.pts.length === 2 && Math.hypot(p.x - s.pts[0], p.y - s.pts[1]) < tol + s.w / 2;
  });
  if (hitStroke) {
    if (!gesture.erased) { remember(); gesture.erased = true; }
    d.strokes = d.strokes.filter((s) => s !== hitStroke);
    renderStrokes();
    return true;
  }
  return false;
}

/* ─────────────── 애플 펜슬 모드 (손바닥 무시) ─────────────── */
// 펜슬을 한 번 쓰면 켜집니다: 그리기·선택은 펜슬로만, 손가락은 화면 옮기기(한 손가락)·확대(두 손가락).
// 펜슬이 닿아 있는 동안(그리고 뗀 뒤 잠깐)은 손바닥 터치를 모두 무시하고, 도구 단추도 손바닥으로는 안 눌리게 합니다.
let penMode = (() => { try { return localStorage.getItem('ref:penMode') === '1'; } catch { return false; } })();
let penDownId = null;
let lastPenAt = 0;
const penBusy = () => penDownId !== null || Date.now() - lastPenAt < 800;
function setPenMode(on) {
  penMode = on;
  try { localStorage.setItem('ref:penMode', on ? '1' : '0'); } catch { /* 저장 못 해도 이번만 */ }
}

// 손바닥이 도구 단추·패널을 누르는 것 막기 (펜슬을 쓰는 중이면 손가락 탭을 버림)
let touchDownAt = 0;
document.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'pen') lastPenAt = Date.now();
  if (e.pointerType === 'touch') touchDownAt = Date.now();
}, true);
document.addEventListener('pointermove', (e) => { if (e.pointerType === 'pen' && e.pressure > 0) lastPenAt = Date.now(); }, true);
document.addEventListener('click', (e) => {
  if (!penMode || stage.contains(e.target)) return;
  const byTouch = e.pointerType ? e.pointerType === 'touch' : Date.now() - touchDownAt < 1500;
  // 손가락이 닿은 뒤로 펜슬을 썼거나 펜슬이 아직 닿아 있으면 손바닥으로 봅니다.
  if (byTouch && (penDownId !== null || lastPenAt >= touchDownAt - 300)) { e.preventDefault(); e.stopImmediatePropagation(); }
}, true);

// 아이패드 '손글씨 입력(Scribble)'이 끊어 쓴 펜슬 획을 글자 입력으로 가져가 그림이 사라지는 것을 막습니다.
// (터치 기본 동작을 막으면 Scribble·확대경·스크롤이 끼어들지 않음 — 포인터 이벤트는 그대로 옴)
for (const t of ['touchstart', 'touchmove']) stage.addEventListener(t, (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });

stage.addEventListener('pointerdown', (e) => {
  if (!ed.board) return;
  if (e.pointerType === 'pen' && document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); // 글자 칸에 커서가 있으면 손글씨 입력이 켜지므로
  if (e.pointerType === 'pen') {
    if (!penMode) { setPenMode(true); toast('펜슬 모드를 켰어요: 펜슬로만 그리고, 손가락은 화면 옮기기·확대예요 (더보기에서 끌 수 있어요)'); }
    penDownId = e.pointerId;
    // 손가락(손바닥)으로 하던 옮기기·확대는 그만두고 펜슬만 봅니다.
    if (gesture && (gesture.kind === 'pan' || gesture.kind === 'pinch')) gesture = null;
    for (const id of [...pointers.keys()]) if (id !== e.pointerId) pointers.delete(id);
  } else if (penMode && e.pointerType === 'touch' && penBusy()) {
    return; // 펜슬로 그리는 중에 닿은 손바닥
  }
  stage.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size === 2) {
    // 두 손가락: 확대·이동. 그리던 선은 취소합니다.
    if (gesture?.kind === 'draw') { gesture.path.remove(); }
    const [a, b] = [...pointers.values()];
    gesture = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    return;
  }
  if (pointers.size > 2) return;

  const p = toBoard(e);
  const hit = hitItem(e);
  const tool = e.button === 1 || (penMode && e.pointerType === 'touch') ? 'pan' : ed.tool;

  if (tool === 'pan') {
    gesture = { kind: 'pan', last: { x: e.clientX, y: e.clientY } };
  } else if (tool === 'pen') {
    const u = upp();
    const w = Math.round(ed.width * u * 10) / 10;
    const path = el('path', {}, $('#layerStrokes'));
    // 펜슬이면 필압을 점마다 기록 (마우스·손가락은 일정한 굵기)
    const pr = usePressure && e.pointerType === 'pen' ? [Math.max(0.05, e.pressure || 0.5)] : null;
    gesture = { kind: 'draw', pts: [p.x, p.y], path, w, u, pr };
    const show = () => { for (const [k, v] of Object.entries(strokeAttrs({ pts: gesture.pts.length === 2 ? [p.x, p.y, p.x, p.y] : gesture.pts, pr: gesture.pr, w, color: ed.color }))) path.setAttribute(k, v); };
    gesture.show = show;
    show();
  } else if (tool === 'eraser') {
    gesture = { kind: 'erase', erased: false };
    if (!eraseAt(p) && hit && hit.type !== 'stroke') {
      // 조명·글자는 지우개로 누르면 바로 지워집니다.
      select(hit);
      deleteSelected();
    }
  } else if (tool === 'light') {
    if (hit?.type === 'light') {
      select(hit);
      gesture = startMove(hit, p);
    } else {
      remember();
      const l = { id: uid(), x: p.x, y: p.y, k: ed.lastKelvin || 3000, power: 80, size: 160, kind: ed.lastKind || 'down', name: '', memo: '' };
      ed.board.data.lights.push(l);
      renderLights();
      select({ type: 'light', id: l.id });
      scheduleSave();
      gesture = startMove({ type: 'light', id: l.id }, p, true);
    }
  } else if (tool === 'text') {
    if (hit?.type === 'text') {
      select(hit);
      gesture = startMove(hit, p);
    } else {
      remember();
      const t = { id: uid(), x: p.x, y: p.y, text: '글자', size: Math.round(22 * upp()), color: ed.color };
      ed.board.data.texts.push(t);
      renderTexts();
      select({ type: 'text', id: t.id });
      scheduleSave();
      setTimeout(() => { const ta = $('#propBox [data-f="text"]'); ta?.focus(); ta?.select(); }, 60);
      gesture = null;
    }
  } else if (tool === 'select' && hit?.type === 'bgHandle') {
    const b = { ...bgBoxOf(ed.board.data) };
    const anchor = { nw: [b.x + b.w, b.y + b.h], ne: [b.x, b.y + b.h], sw: [b.x + b.w, b.y], se: [b.x, b.y] }[hit.id];
    gesture = { kind: 'resizeBg', corner: hit.id, anchor, orig: b, d0: Math.hypot(p.x - anchor[0], p.y - anchor[1]) || 1, moved: false };
  } else if (tool === 'select' && hit?.type === 'bg') {
    if (ed.selected?.type === 'bg') {
      gesture = { kind: 'moveBg', start: p, orig: { ...bgBoxOf(ed.board.data) }, moved: false };
    } else {
      // 한 번 누르면 도면 옮기기·크기 조절 켜짐 (끌면 지금처럼 화면 옮기기)
      select({ type: 'bg', id: 'bg' });
      gesture = { kind: 'pan', last: { x: e.clientX, y: e.clientY } };
    }
  } else if (tool === 'select') {
    if (hit) {
      select(hit);
      gesture = hit.type === 'stroke' ? startMoveStroke(hit, p) : startMove(hit, p);
    } else {
      select(null);
      gesture = { kind: 'pan', last: { x: e.clientX, y: e.clientY } };
    }
  }
});

function addDrawPoint(p, e) {
  const pts = gesture.pts;
  const lx = pts[pts.length - 2]; const ly = pts[pts.length - 1];
  if (Math.hypot(p.x - lx, p.y - ly) < 1.5 * gesture.u) return;
  pts.push(p.x, p.y);
  if (gesture.pr) {
    // 손 떨림처럼 튀지 않게 부드럽게 (앞 값 60% + 새 값 40%)
    const prev = gesture.pr[gesture.pr.length - 1];
    gesture.pr.push(prev * 0.6 + Math.max(0.05, e.pressure || prev) * 0.4);
  }
}

function startMove(hit, p, alreadyRemembered = false) {
  const list = hit.type === 'light' ? ed.board.data.lights : ed.board.data.texts;
  const item = list.find((x) => x.id === hit.id);
  return { kind: 'move', item, type: hit.type, off: { x: p.x - item.x, y: p.y - item.y }, moved: false, remembered: alreadyRemembered };
}

function startMoveStroke(hit, p) {
  const item = ed.board.data.strokes.find((x) => x.id === hit.id);
  return { kind: 'moveStroke', item, start: p, orig: [...item.pts], moved: false };
}

stage.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId) || !gesture) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (gesture.kind === 'pinch' && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const rect = svg.getBoundingClientRect();
    const scale = ed.view.w / rect.width; // 화면 1px = 도화지 몇 칸 (대략)
    ed.view.x -= (mid.x - gesture.mid.x) * scale;
    ed.view.y -= (mid.y - gesture.mid.y) * scale;
    const c = toBoard({ clientX: mid.x, clientY: mid.y });
    zoomAt(dist / gesture.dist, c.x, c.y);
    gesture.dist = dist;
    gesture.mid = mid;
    return;
  }

  if (gesture.kind === 'pan') {
    const rect = svg.getBoundingClientRect();
    const scale = Math.max(ed.view.w / rect.width, ed.view.h / rect.height);
    ed.view.x -= (e.clientX - gesture.last.x) * scale;
    ed.view.y -= (e.clientY - gesture.last.y) * scale;
    gesture.last = { x: e.clientX, y: e.clientY };
    applyView();
    return;
  }

  const p = toBoard(e);
  if (gesture.kind === 'draw') {
    // 빠르게 짧게 그은 획은 브라우저가 점 여러 개를 하나로 묶어 보내므로, 묶인 점(getCoalescedEvents)까지 모두 씁니다.
    const evs = e.getCoalescedEvents?.().length ? e.getCoalescedEvents() : [e];
    for (const ev of evs) addDrawPoint(toBoard(ev), ev);
    gesture.show();
  } else if (gesture.kind === 'erase') {
    eraseAt(p);
  } else if (gesture.kind === 'move') {
    if (!gesture.moved && Math.hypot(p.x - (gesture.item.x + gesture.off.x), p.y - (gesture.item.y + gesture.off.y)) < 3) return;
    if (!gesture.remembered) { remember(); gesture.remembered = true; }
    gesture.moved = true;
    gesture.item.x = Math.round(p.x - gesture.off.x);
    gesture.item.y = Math.round(p.y - gesture.off.y);
    redrawItem(gesture.type);
  } else if (gesture.kind === 'moveBg' || gesture.kind === 'resizeBg') {
    const d = ed.board.data;
    const o = gesture.orig;
    if (gesture.kind === 'moveBg') {
      const dx = p.x - gesture.start.x; const dy = p.y - gesture.start.y;
      if (!gesture.moved && Math.hypot(dx, dy) < 3 * upp()) return;
      if (!gesture.moved) { remember(); gesture.moved = true; }
      d.bgBox = { ...o, x: Math.round(o.x + dx), y: Math.round(o.y + dy) };
    } else {
      if (!gesture.moved) { remember(); gesture.moved = true; }
      const [ax, ay] = gesture.anchor;
      const k = Math.max(0.05, Math.hypot(p.x - ax, p.y - ay) / gesture.d0);
      const w = Math.round(o.w * k); const h = Math.round(o.h * k);
      const c = gesture.corner;
      d.bgBox = { w, h, x: c === 'nw' || c === 'sw' ? ax - w : ax, y: c === 'nw' || c === 'ne' ? ay - h : ay };
    }
    renderBackground();
    renderSelection();
  } else if (gesture.kind === 'moveStroke') {
    const dx = p.x - gesture.start.x; const dy = p.y - gesture.start.y;
    if (!gesture.moved && Math.hypot(dx, dy) < 3) return;
    if (!gesture.moved) { remember(); gesture.moved = true; }
    gesture.item.pts = gesture.orig.map((v, i) => Math.round((v + (i % 2 ? dy : dx)) * 10) / 10);
    redrawItem('stroke');
  }
});

function endPointer(e) {
  if (e.pointerId === penDownId) { penDownId = null; lastPenAt = Date.now(); }
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (!gesture) return;
  if (gesture.kind === 'pinch') {
    if (pointers.size === 0) gesture = null;
    return;
  }
  if (gesture.kind === 'draw') {
    const pts = gesture.pts;
    // 펜을 뗀 자리까지 이어 줌 (빠른 짧은 획이 점으로만 남지 않게)
    if (e.type === 'pointerup' && Number.isFinite(e.clientX)) addDrawPoint(toBoard(e), e);
    if (pts.length === 2) pts.push(pts[0], pts[1]);
    remember();
    const st = { id: uid(), color: ed.color, w: gesture.w, pts };
    if (gesture.pr) {
      const pr = gesture.pr.map((v) => Math.round(v * 100) / 100);
      while (pr.length < pts.length / 2) pr.push(pr[pr.length - 1]);
      st.pr = pr;
    }
    ed.board.data.strokes.push(st);
    renderStrokes();
    scheduleSave();
  } else if ((gesture.kind === 'moveBg' || gesture.kind === 'resizeBg') && gesture.moved) {
    scheduleSave();
  } else if ((gesture.kind === 'move' && gesture.moved) || (gesture.kind === 'moveStroke' && gesture.moved) || (gesture.kind === 'erase' && gesture.erased)) {
    scheduleSave();
  }
  gesture = null;
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);

stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const c = toBoard(e);
  if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), c.x, c.y);
  } else {
    const rect = svg.getBoundingClientRect();
    ed.view.x += e.deltaX * (ed.view.w / rect.width);
    applyView();
  }
}, { passive: false });

/* ─────────────── 도구 · 단추 ─────────────── */

function setTool(tool) {
  ed.tool = tool;
  document.querySelectorAll('.tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  $('#penOpts').hidden = !(tool === 'pen' || tool === 'text');
  stage.dataset.tool = tool;
}

function renderPenOpts() {
  $('#swatches').innerHTML = COLORS.map((c) => `<button data-c="${c}" class="${ed.color === c ? 'on' : ''}" style="--c:${c}" aria-label="색"></button>`).join('');
  $('#widths').innerHTML = WIDTHS.map((w) => `<button data-w="${w}" class="${ed.width === w ? 'on' : ''}" aria-label="굵기"><i style="width:${w * 1.5 + 4}px;height:${w * 1.5 + 4}px"></i></button>`).join('');
  $('#swatches').querySelectorAll('button').forEach((b) => (b.onclick = () => { ed.color = b.dataset.c; renderPenOpts(); }));
  $('#widths').querySelectorAll('button').forEach((b) => (b.onclick = () => { ed.width = Number(b.dataset.w); renderPenOpts(); }));
}

function openPanel(on) {
  $('#panel').classList.toggle('open', on);
  $('#panelToggle').classList.toggle('on', on);
}

function bindEditor() {
  renderPenOpts();
  document.querySelectorAll('.tool[data-tool]').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
  $('#undoBtn').onclick = doUndo;
  $('#redoBtn').onclick = doRedo;
  $('#edBack').onclick = () => { location.hash = ''; };
  $('#panelToggle').onclick = () => openPanel(!$('#panel').classList.contains('open'));
  $('#panelGrip').onclick = () => openPanel(false);
  $('#edTitle').addEventListener('input', scheduleSave);
  $('#planNote').addEventListener('input', () => { ed.board.data.note = $('#planNote').value; scheduleSave(); });
  $('#edMore').onclick = moreMenu;

  $('#todoForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('#todoText').value.trim();
    if (!text) return;
    ed.board.data.todos.push({ id: uid(), text: text.slice(0, 300), date: $('#todoDate').value || '', done: false });
    $('#todoText').value = '';
    renderTodos();
    scheduleSave();
  };

  // 새로 놓는 조명은 마지막으로 고른 색온도·종류를 따라갑니다.
  $('#propBox').addEventListener('change', () => {
    const l = ed.selected?.type === 'light' && findSelected();
    if (l) { ed.lastKelvin = l.k; ed.lastKind = l.kind; }
  });
  $('#propBox').addEventListener('click', () => {
    const l = ed.selected?.type === 'light' && findSelected();
    if (l) { ed.lastKelvin = l.k; ed.lastKind = l.kind; }
  });

  document.addEventListener('keydown', (e) => {
    if ($('#editorScreen').hidden) return;
    const typing = e.target.closest('input, textarea, [contenteditable]');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) {
      e.preventDefault();
      e.shiftKey ? doRedo() : doUndo();
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    const map = { v: 'select', p: 'pen', l: 'light', t: 'text', e: 'eraser' };
    if (map[e.key.toLowerCase()]) setTool(map[e.key.toLowerCase()]);
    if ((e.key === 'Delete' || e.key === 'Backspace') && ed.selected) deleteSelected();
    if (e.key === 'Escape') select(null);
  });

  $('#bgInput').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    toast('도면·사진을 올리는 중이에요');
    try {
      const blob = await resizeImage(file, 2400);
      const { key } = await api('/api/images', { method: 'POST', raw: blob, type: blob.type });
      ed.board.data.bg = key;
      delete ed.board.data.bgBox; // 새 도면은 사진 비율에 맞춰 다시 자리 잡기
      ed.board.data.bgOpacity = ed.board.data.bgOpacity || 1;
      renderBackground();
      scheduleSave();
      toast('배경을 넣었어요');
    } catch (err) {
      toast(err.message);
    }
  };
}

function moreMenu() {
  const d = ed.board.data;
  openSheet(`
    <h2>더보기</h2>
    <ul class="options">
      <li><button data-a="bg">${d.bg ? '배경 도면·사진 바꾸기' : '배경에 도면·사진 넣기'}</button></li>
      ${d.bg ? `<li><button data-a="bgEdit">도면 옮기기·크기 바꾸기</button></li><li><button data-a="fade">${d.bgOpacity < 1 ? '배경 진하게' : '배경 흐리게'}</button></li><li><button data-a="nobg">배경 빼기</button></li>` : ''}
      <li><button data-a="grid">${d.grid ? '격자 숨기기' : '격자 보이기'}</button></li>
      <li><button data-a="pen">애플 펜슬 모드 <span class="n">${penMode ? '켜짐 · 끄기' : '꺼짐 · 켜기'}</span></button></li>
      <li><button data-a="pressure">펜슬 필압 (세게 누르면 굵게) <span class="n">${usePressure ? '켜짐 · 끄기' : '꺼짐 · 켜기'}</span></button></li>
      <li><button data-a="png">그림으로 저장 (PNG)</button></li>
      <li><button data-a="del" style="color:var(--red)">이 계획 지우기</button></li>
    </ul>`);
  sheetBody().querySelectorAll('[data-a]').forEach((b) => (b.onclick = async () => {
    const a = b.dataset.a;
    await closeSheet();
    if (a === 'bg') $('#bgInput').click();
    if (a === 'bgEdit') { setTool('select'); select({ type: 'bg', id: 'bg' }); toast('도면을 끌어 옮기고, 모서리 동그라미로 크기를 바꿔요'); }
    if (a === 'fade') { d.bgOpacity = d.bgOpacity < 1 ? 1 : 0.4; renderBackground(); scheduleSave(); }
    if (a === 'nobg') { d.bg = null; renderBackground(); scheduleSave(); }
    if (a === 'grid') { d.grid = !d.grid; renderBackground(); scheduleSave(); }
    if (a === 'png') exportPng();
    if (a === 'pressure') {
      usePressure = !usePressure;
      try { localStorage.setItem('ref:pressure', usePressure ? '1' : '0'); } catch { /* 이번만 */ }
      toast(usePressure ? '필압을 켰어요: 펜슬을 세게 누르면 굵게, 살살 누르면 가늘게 그려져요' : '필압을 껐어요: 늘 같은 굵기로 그려져요');
    }
    if (a === 'pen') { setPenMode(!penMode); toast(penMode ? '펜슬 모드: 펜슬로만 그리고 손가락은 화면 옮기기·확대예요' : '펜슬 모드를 껐어요: 손가락으로도 그려요'); }
    if (a === 'del') confirmDeleteBoard();
  }));
}

function confirmDeleteBoard() {
  openSheet(`
    <h2>이 계획을 지울까요?</h2>
    <p style="color:var(--text-2);margin:-8px 0 24px">그림, 조명, 할 일, 메모가 모두 지워지고 되돌릴 수 없어요.</p>
    <div class="btn-row"><button class="btn ghost" id="no">취소</button><button class="btn" style="background:var(--red)" id="yes">지우기</button></div>`);
  $('#no').onclick = () => closeSheet();
  $('#yes').onclick = async () => {
    setBusy($('#yes'), true);
    try {
      clearTimeout(ed.saveTimer);
      ed.dirty = false;
      await api(`/api/boards/${ed.board.id}`, { method: 'DELETE' });
      ed.board = null;
      await closeSheet();
      location.hash = '';
      toast('지웠어요');
    } catch (err) {
      toast(err.message);
      setBusy($('#yes'), false);
    }
  };
}

async function exportPng() {
  toast('그림을 만드는 중이에요');
  try {
    const box = contentBox() || { x: 0, y: 0, w: W, h: H };
    const pad = Math.max(box.w, box.h) * 0.05;
    const vb = { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 };
    const scale = 3000 / Math.max(vb.w, vb.h);
    const cw = Math.round(vb.w * scale);
    const ch = Math.round(vb.h * scale);
    // 그림 크기에 맞춰 조명 이름표를 다시 그립니다 (화면 확대 정도와 상관없이 읽히는 크기)
    renderLights(2 / scale);
    const clone = svg.cloneNode(true);
    renderLights();
    clone.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    clone.setAttribute('width', cw);
    clone.setAttribute('height', ch);
    clone.querySelector('#layerSelect').innerHTML = '';
    const bg = clone.querySelector('#bgImage');
    if (ed.board.data.bg) {
      // 그림 파일 안에 배경 사진을 직접 넣어야 PNG 에 같이 나옵니다.
      const blob = await (await fetch(`/img/${ed.board.data.bg}`)).blob();
      bg.setAttribute('href', await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); }));
    }
    const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`;
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(img, 0, 0, cw, ch);
    const a = document.createElement('a');
    a.download = `${($('#edTitle').value || '계획').replace(/[\\/:*?"<>|]/g, '')}.png`;
    a.href = canvas.toDataURL('image/png');
    a.click();
  } catch {
    renderLights();
    toast('그림으로 저장하지 못했어요');
  }
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}
