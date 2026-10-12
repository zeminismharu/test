// 레퍼런스 · 관리 화면이 같이 쓰는 도우미

export const $ = (sel, root = document) => root.querySelector(sel);

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function api(path, { method = 'GET', body, raw, type } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (raw) {
    opts.body = raw;
    opts.headers['content-type'] = type;
  } else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers['content-type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new Error('인터넷 연결을 확인해 주세요');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `오류가 났어요 (${res.status})`), { status: res.status, data });
  return data;
}

let toastTimer;
export function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

export function setBusy(btn, on) {
  if (!btn) return;
  btn.disabled = on;
  btn.classList.toggle('loading', on);
}

// 한글 초성 뽑기: "고흐" → "ㄱㅎ"
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
export function choseong(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0) - 0xac00;
    out += c >= 0 && c < 11172 ? CHO[Math.floor(c / 588)] : ch;
  }
  return out;
}

export function fmtDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

// 사진을 올리기 전에 긴 변 2000px 로 줄여 저장 공간과 시간을 아낍니다. (움직이는 GIF 는 그대로)
export async function resizeImage(file, max = 2000) {
  if (file.type === 'image/gif') {
    if (file.size > 8 * 1024 * 1024) throw new Error('GIF가 너무 커요 (8MB까지)');
    return file;
  }
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('이 사진 형식은 열 수 없어요 (jpg, png로 바꿔서 넣어 주세요)');
  }
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // 투명 PNG 를 JPG 로 바꿀 때 검게 나오지 않도록
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('사진을 바꾸지 못했어요'))), 'image/jpeg', 0.86)
  );
}

/* ── 바텀시트 ── */
let onCloseCb = null;
let sheetOpen = false;

export const sheetBody = () => $('#sheetBody');

export function openSheet(html, { onClose } = {}) {
  if (sheetOpen && onCloseCb) { const cb = onCloseCb; onCloseCb = null; cb(); }
  onCloseCb = onClose || null;
  $('#sheetBody').innerHTML = html;
  $('#sheetBody').scrollTop = 0;
  $('#sheet').hidden = false;
  $('#backdrop').hidden = false;
  document.body.style.overflow = 'hidden';
  if (!sheetOpen) history.pushState({ sheet: true }, '');
  sheetOpen = true;
}

// 닫은 뒤 화면 이동을 해야 하면 await 해 주세요. (뒤로가기 기록이 정리된 다음에 이어집니다)
let popWaiter = null;
export function closeSheet(fromPop = false) {
  if (!sheetOpen) return Promise.resolve();
  sheetOpen = false;
  $('#sheet').hidden = true;
  $('#backdrop').hidden = true;
  document.body.style.overflow = '';
  if (onCloseCb) { const cb = onCloseCb; onCloseCb = null; cb(); }
  if (!fromPop && history.state?.sheet) {
    return new Promise((resolve) => {
      popWaiter = resolve;
      history.back();
      setTimeout(() => { if (popWaiter === resolve) { popWaiter = null; resolve(); } }, 400);
    });
  }
  return Promise.resolve();
}

// 휴대폰 "뒤로" 를 누르면 시트만 닫히도록
window.addEventListener('popstate', () => {
  if (popWaiter) { const r = popWaiter; popWaiter = null; r(); return; }
  closeSheet(true);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
document.addEventListener('DOMContentLoaded', () => {
  const bd = $('#backdrop');
  if (bd) bd.onclick = () => closeSheet();
});
if (document.readyState !== 'loading') {
  const bd = $('#backdrop');
  if (bd) bd.onclick = () => closeSheet();
}

export const ICON = {
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>',
  stack: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="13" height="13" rx="3"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/></svg>',
  pencil: '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  camera: '<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
};
