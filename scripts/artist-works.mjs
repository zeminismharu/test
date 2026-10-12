// data/artist-works.json 의 대표작을 사이트에 넣습니다. (GitHub Actions 에서 실행)
import { readFileSync } from 'node:fs';

const B = 'https://zeminism-archive.pages.dev';
const MODE = process.env.MODE || 'list';
const list = JSON.parse(readFileSync('data/artist-works.json', 'utf8'));
const UA = { 'user-agent': 'Mozilla/5.0 (compatible; zeminism-archive/1.0; personal reference archive)', 'accept-language': 'ko,en' };

const abs = (u, base) => { try { return new URL(u.replace(/&amp;/g, '&'), base).href; } catch { return ''; } };

async function candidates(page) {
  const res = await fetch(page, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(15000) });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const html = await res.text();
  const out = [];
  const og = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i);
  if (og) out.push({ src: abs(og[1], res.url), alt: '(og:image)' });
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = (tag.match(/\s(?:data-src|data-lazy-src|data-original|src)=["']([^"']+)["']/i) || [])[1];
    if (!src || /^data:|\.svg|\.gif|logo|icon|sprite|banner|blank|spacer|avatar|profile|btn_|button/i.test(src)) continue;
    const alt = (tag.match(/\salt=["']([^"']*)["']/i) || [])[1] || '';
    const url = abs(src, res.url);
    if (url && !out.some((o) => o.src === url)) out.push({ src: url, alt: alt.slice(0, 120) });
  }
  // 사진 설명(figcaption)도 같이 보여줌
  const caps = [...html.matchAll(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/gi)].map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 8);
  return { items: out.slice(0, 30), caps };
}

async function login() {
  const r = await fetch(`${B}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: process.env.ADMIN_PASSWORD || '' }) });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  console.log('로그인', r.status);
  return cookie;
}

if (MODE === 'list') {
  const seen = new Map();
  for (const a of list) for (const w of a.works) {
    console.log(`\n===== ${a.artist} · ${w.titleKo || w.title} (${w.year})`);
    for (const p of w.pages || []) {
      if (!seen.has(p)) seen.set(p, await candidates(p).catch((e) => ({ error: String(e.message || e) })));
      const c = seen.get(p);
      console.log(`--- ${p}`);
      if (c.error) { console.log('   (못 읽음)', c.error); continue; }
      for (const i of c.items) console.log(`   ${i.alt ? `[${i.alt}] ` : ''}${i.src}`);
      for (const cap of c.caps) console.log(`   캡션: ${cap}`);
    }
  }
} else {
  const cookie = await login();
  for (const a of list) {
    const works = [];
    for (const w of a.works) {
      const { pages, match, image, ...rest } = w;
      let key = '';
      if (image) {
        try {
          const res = await fetch(image, { headers: { ...UA, referer: (pages || [])[0] || '' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
          const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
          const buf = await res.arrayBuffer();
          if (!res.ok || !/^image\/(jpeg|png|webp)$/.test(type) || buf.byteLength < 3000) throw new Error(`HTTP ${res.status} ${type} ${buf.byteLength}B`);
          if (buf.byteLength > 8 * 1024 * 1024) throw new Error('8MB 넘음');
          const up = await fetch(`${B}/api/images`, { method: 'POST', headers: { 'content-type': type, cookie }, body: buf });
          const j = await up.json();
          if (!up.ok) throw new Error(j.error || `upload ${up.status}`);
          key = j.key;
          console.log(`✓ ${a.artist} · ${rest.titleKo || rest.title}: ${Math.round(buf.byteLength / 1024)}KB`);
        } catch (e) { console.log(`✗ ${a.artist} · ${rest.titleKo || rest.title}: 그림 못 받음 (${e.message})`); }
      } else console.log(`- ${a.artist} · ${rest.titleKo || rest.title}: 그림 주소 없음`);
      works.push({ ...rest, image: key, imageFrom: key ? image : '', page: rest.page || (pages || [])[0] || '' });
    }
    const r = await fetch(`${B}/api/artists/${encodeURIComponent(a.artist)}/works`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ works }) });
    console.log(`  → ${a.artist} 저장 ${r.status}`);
  }
}
