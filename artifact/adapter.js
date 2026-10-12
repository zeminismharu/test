// Claude 아티팩트용 저장소 연결
// Cloudflare 서버(_worker.js) 대신 Claude 저장소(db: 글, assets: 사진)와 Claude AI(sample)를 씁니다.
// 화면 코드가 부르는 api('/api/...') 주소를 그대로 받아서 같은 모양의 답을 돌려줍니다.

const CAPS = (async () => {
  const c = window.claude;
  if (!c?.use) return {};
  const [db, assets, sample, user] = await Promise.all(
    ['db', 'assets', 'sample', 'user'].map((n) => c.use(n).catch(() => null))
  );
  return { db, assets, sample, user };
})();

const CATEGORIES = ['exhibition', 'movie', 'etc'];
const LIMITS = { place: 100, title: 200, artist: 100, memo: 10000, source: 1000, tag: 40, tags: 30, description: 5000 };

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

function dbError(err) {
  const code = err?.code;
  if (code === 'invalid_argument') fail('저장하지 못했어요. 편집 권한이 없거나 내용이 너무 커요.', 403);
  if (code === 'quota_exceeded') fail('저장 공간이 가득 찼어요. 오래된 항목을 지워 주세요.', 507);
  if (code === 'resource_exhausted') fail('너무 빨리 저장하고 있어요. 잠시 뒤 다시 해 주세요.', 429);
  fail('저장소에 연결하지 못했어요. 잠시 뒤 다시 해 주세요.', 503);
}

async function need(name) {
  const caps = await CAPS;
  if (!caps[name]) {
    if (name === 'assets') fail('사진은 편집 권한이 있는 사람만 올릴 수 있어요.', 403);
    if (name === 'sample') fail('이 화면에서는 AI를 쓸 수 없어요.', 503);
    fail('저장소에 연결하지 못했어요. Claude 에서 이 페이지를 열어 주세요.', 503);
  }
  return caps[name];
}

async function canWrite() {
  const { user, db } = await CAPS;
  if (!db) return false;
  const v = await user?.can('data.write').catch(() => null);
  return v !== false; // null(모름)이면 일단 허용하고, 실제 저장이 거절되면 그때 알려줍니다
}

const str = (v, max) => String(v ?? '').trim().slice(0, max);

function cleanItem(body) {
  const tags = [...new Set((Array.isArray(body.tags) ? body.tags : [])
    .map((t) => str(t, LIMITS.tag).replace(/^#/, ''))
    .filter(Boolean))].slice(0, LIMITS.tags);
  const images = (Array.isArray(body.images) ? body.images : []).map(String).filter((k) => /^[A-Za-z0-9_-]{8,64}$/.test(k)).slice(0, 20);
  return {
    title: str(body.title, LIMITS.title),
    artist: str(body.artist, LIMITS.artist),
    category: CATEGORIES.includes(body.category) ? body.category : 'etc',
    place: str(body.place, LIMITS.place),
    memo: str(body.memo, LIMITS.memo),
    source: str(body.source, LIMITS.source),
    tags,
    images,
  };
}

function toItem(snap) {
  const d = snap.data();
  return {
    id: snap.id, title: d.title || '', artist: d.artist || '', category: CATEGORIES.includes(d.category) ? d.category : 'etc', place: d.place || '', memo: d.memo || '', tags: d.tags || [],
    source: d.source || '', images: d.images || [], createdAt: d.createdAt || 0, updatedAt: d.updatedAt || 0,
  };
}

// 작가 이름 → 저장소 문서 이름 (한글·공백은 문서 이름에 못 쓰므로 해시로 바꿈)
async function artistKey(name) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name));
  return 'a' + [...new Uint8Array(buf)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function allItems(db) {
  const snap = await db.collection('items').orderBy('createdAt', 'desc').limit(1000).get().catch(dbError);
  return snap.docs.filter((d) => d.exists).map(toItem);
}

function boardSummary(data) {
  const lights = Array.isArray(data.lights) ? data.lights : [];
  const todos = Array.isArray(data.todos) ? data.todos : [];
  return {
    lights: lights.length,
    kelvins: [...new Set(lights.map((l) => Number(l.k)).filter(Number.isFinite))].sort((a, b) => a - b).slice(0, 8),
    todos: todos.length,
    done: todos.filter((t) => t.done).length,
    bg: typeof data.bg === 'string' ? data.bg : null,
  };
}

// 같은 작가인지 비교할 때 띄어쓰기·기호·대소문자는 무시합니다.
const artistKeyOf = (n) => String(n || '').toLowerCase().normalize('NFC').replace(/[\s.\-_·'"()]/g, '');
function matchArtist(name, existing) {
  const k = artistKeyOf(name);
  if (!k) return '';
  return existing.find((e) => artistKeyOf(e) === k) || String(name).trim().slice(0, LIMITS.artist);
}
const artistsOf = (items, exceptId) => [...new Set(items.filter((i) => i.id !== exceptId && i.artist).map((i) => i.artist))];

async function analyzeWithAi(key, items) {
  const sample = await need('sample');
  const caps = await sample.limits().catch(() => null);
  if (!caps?.images) fail('이 화면에서는 AI에게 사진을 보낼 수 없어요.', 503);
  const blob = await (await fetch(`/_blob/${key}`)).blob();
  const existing = artistsOf(items);
  const prompt = [
    '첨부한 사진은 사용자가 아이디어 아카이브에 모으는 레퍼런스입니다. 사진을 보고 아래 키를 가진 JSON 객체 하나로만 답하세요.',
    '- category: "exhibition"(전시·미술관·갤러리·설치작품·작품 사진·전시 포스터), "movie"(영화 장면·스틸컷·영화 포스터·드라마), "etc"(그 외 전부) 중 하나',
    '- title: 전시면 전시 이름(전시명), 영화면 영화 제목. 알 수 없으면 무엇이 보이는지 짧은 한국어 제목. 개별 작품 이름은 memo 에',
    '- artist: 작가·감독·디자이너 이름. 확실할 때만, 모르면 ""',
    '- place: 전시관·미술관·갤러리 이름(전시일 때), 사진에 글자로 보이거나 확실할 때만. 모르면 ""',
    '- tags: 한국어 태그 2~5개 배열',
    '- memo: 사진에서 눈여겨볼 점 한두 문장 (한국어)',
    existing.length ? `사용자가 이미 저장한 작가: ${existing.slice(0, 300).join(', ')}` : '아직 저장된 작가가 없습니다.',
    '위 목록에 같은 사람이 있으면(영어·한국어 표기가 달라도) 목록의 이름을 글자 그대로 쓰세요. 새 작가면 한국어 표기로. 추측하지 마세요.',
  ].join('\n');
  let o;
  try {
    o = await sample.json(prompt, { images: [blob], modelTier: 'default' });
  } catch (err) {
    if (err?.code === 'not_granted') fail('AI 사용을 허락하지 않아서 분석하지 못했어요.', 403);
    if (err?.code === 'rate_limited') fail('AI를 너무 자주 불렀어요. 잠시 뒤 다시 해 주세요.', 429);
    fail('사진을 분석하지 못했어요.', 502);
  }
  o = o && typeof o === 'object' ? o : {};
  return {
    category: CATEGORIES.includes(o.category) ? o.category : 'etc',
    title: str(o.title, LIMITS.title),
    artist: matchArtist(o.artist, existing),
    place: str(o.place, LIMITS.place),
    tags: (Array.isArray(o.tags) ? o.tags : []).map((t) => str(t, LIMITS.tag).replace(/^#/, '')).filter(Boolean).slice(0, 5),
    memo: str(o.memo, 500),
  };
}

// 여러 장을 같이 보여주고 같은 관람(같은 전시·영화)끼리 묶습니다. 한 번에 보낼 수 있는 장수를 넘으면 나눠 묻고 제목이 같은 묶음을 합칩니다.
async function groupWithAi(photos, items) {
  const sample = await need('sample');
  const caps = await sample.limits().catch(() => null);
  if (!caps?.images) fail('이 화면에서는 AI에게 사진을 보낼 수 없어요.', 503);
  const existing = artistsOf(items);
  const per = Math.max(1, caps.images.maxCount || 1);
  const all = [];
  for (let start = 0; start < photos.length; start += per) {
    const chunk = photos.slice(start, start + per);
    const prompt = [
      `첨부한 사진 ${chunk.length}장은 사용자가 아이디어 아카이브에 한꺼번에 넣으려는 사진입니다. 번호는 첨부 순서대로 0부터입니다.`,
      chunk.some((p) => p.date) ? `찍은 날짜: ${chunk.map((p, i) => `${i}=${p.date || '?'}`).join(', ')}` : '',
      '같은 관람(같은 전시를 보러 가서 찍은 사진, 같은 영화의 장면·포스터)은 한 묶음으로 묶으세요. 다른 전시·다른 영화·관계없는 사진은 나누고, 확실하지 않으면 나누세요.',
      '다음 JSON 하나로만 답하세요: {"groups":[{"photos":[번호...],"category":"exhibition|movie|etc","title":"전시 이름 또는 영화 제목(모르면 무엇을 봤는지)","artist":"확실할 때만, 모르면 \"\"","place":"전시관 이름, 모르면 \"\"","tags":["한국어 태그 2~5개"],"memo":"눈여겨볼 점 한두 문장"}]}',
      '모든 사진 번호는 정확히 한 묶음에만 들어가야 합니다.',
      existing.length ? `이미 저장한 작가: ${existing.slice(0, 300).join(', ')} — 같은 사람이면 이 이름을 그대로 쓰세요.` : '',
    ].filter(Boolean).join('\n');
    let o;
    try {
      o = await sample.json(prompt, { images: chunk.map((p) => p.blob), modelTier: 'default' });
    } catch (err) {
      if (err?.code === 'not_granted') fail('AI 사용을 허락하지 않아서 묶지 못했어요.', 403);
      if (err?.code === 'rate_limited') fail('AI를 너무 자주 불렀어요. 잠시 뒤 다시 해 주세요.', 429);
      fail('사진을 묶지 못했어요.', 502);
    }
    const seen = new Set();
    for (const g of Array.isArray(o?.groups) ? o.groups : []) {
      const idx = (Array.isArray(g?.photos) ? g.photos : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < chunk.length && !seen.has(n));
      idx.forEach((n) => seen.add(n));
      if (idx.length) all.push({ g, photos: idx.map((n) => n + start) });
    }
    for (let i = 0; i < chunk.length; i++) if (!seen.has(i)) all.push({ g: {}, photos: [i + start] });
  }
  // 나눠 물은 묶음 중 분류·제목이 같은 것은 합칩니다.
  const out = [];
  for (const { g, photos: ph } of all) {
    const clean = {
      category: CATEGORIES.includes(g.category) ? g.category : 'etc',
      title: str(g.title, LIMITS.title),
      artist: matchArtist(g.artist, existing),
      place: str(g.place, LIMITS.place),
      tags: (Array.isArray(g.tags) ? g.tags : []).map((t) => str(t, LIMITS.tag).replace(/^#/, '')).filter(Boolean).slice(0, 5),
      memo: str(g.memo, 500),
    };
    const twin = clean.title && out.find((x) => x.category === clean.category && artistKeyOf(x.title) === artistKeyOf(clean.title));
    if (twin) twin.photos.push(...ph);
    else out.push({ photos: ph, ...clean });
  }
  return out;
}

async function describeWithAi(name, items) {
  const sample = await need('sample');
  const mine = items.filter((i) => i.artist === name).slice(0, 15);
  const titles = mine.map((r) => r.title).filter(Boolean);
  const tags = [...new Set(mine.flatMap((r) => r.tags))].slice(0, 20);
  const prompt = [
    `"${name}"라는 작가(아티스트·디자이너·사진가·건축가 등 창작자)를 한국어로 간단히 소개해 주세요.`,
    titles.length ? `참고: 사용자가 이 작가의 작품으로 저장한 것 — ${titles.join(', ')}` : '',
    tags.length ? `참고 태그: ${tags.join(', ')}` : '',
    '',
    '형식:',
    '- 첫 줄: 한 문장 요약 (어느 나라, 어떤 분야, 언제 활동)',
    '- 그다음 3~5줄: 대표 작품, 스타일·특징, 왜 레퍼런스로 볼 만한지',
    '- 마크다운 기호(#, *, **) 없이 평범한 문장으로, 한 줄에 한 문장.',
    '',
    '중요: 확실하지 않은 사실은 지어내지 마세요. 누구인지 확실히 모르거나 동명이인이 여럿이면',
    '"정확한 정보를 찾지 못했습니다."라고 쓰고, 알 수 있는 범위만 짧게 적어 주세요. 소개 글만 답하세요.',
  ].filter((l) => l !== null).join('\n');
  try {
    const { text } = await sample(prompt, { modelTier: 'default' });
    return text.replace(/\*\*/g, '').trim().slice(0, LIMITS.description);
  } catch (err) {
    if (err?.code === 'not_granted') fail('AI 사용을 허락하지 않아서 만들지 못했어요.', 403);
    if (err?.code === 'rate_limited') fail('AI를 너무 자주 불렀어요. 잠시 뒤 다시 해 주세요.', 429);
    fail('AI 설명을 만들지 못했어요. 잠시 뒤 다시 해 주세요.', 502);
  }
}

export async function api(path, { method = 'GET', body, raw } = {}) {
  const parts = path.replace(/^\/api\//, '').split('/').map(decodeURIComponent);
  const [head, id, sub] = parts;
  const m = method;

  if (head === 'session') {
    const w = await canWrite();
    return { loggedIn: w, open: true };
  }
  if (head === 'login') {
    if (await canWrite()) return { ok: true };
    fail('보기 전용으로 열려 있어요. 고치려면 이 페이지의 편집 권한이 필요해요.', 403);
  }
  if (head === 'logout') return { ok: true };

  const db = await need('db');

  if (head === 'items') {
    if (!id && m === 'GET') return { items: await allItems(db) };
    if (!id && m === 'POST') {
      const it = cleanItem(body || {});
      if (!it.title && !it.images.length && !it.memo) fail('제목, 사진, 메모 중 하나는 있어야 합니다.');
      it.artist = matchArtist(it.artist, artistsOf(await allItems(db)));
      const now = Date.now();
      const ref = db.collection('items').doc();
      await ref.set({ ...it, createdAt: now, updatedAt: now }).catch(dbError);
      return { item: { id: ref.id, ...it, createdAt: now, updatedAt: now } };
    }
    const ref = db.collection('items').doc(id);
    const old = await ref.get().catch(dbError);
    if (!old.exists) fail('찾을 수 없습니다.', 404);
    const prev = toItem(old);
    if (m === 'PUT') {
      const it = cleanItem(body || {});
      if (!it.title && !it.images.length && !it.memo) fail('제목, 사진, 메모 중 하나는 있어야 합니다.');
      it.artist = matchArtist(it.artist, artistsOf(await allItems(db), id));
      const now = Date.now();
      await ref.set({ ...it, createdAt: prev.createdAt, updatedAt: now }).catch(dbError);
      const assets = (await CAPS).assets;
      await Promise.all(prev.images.filter((k) => !it.images.includes(k)).map((k) => assets?.delete(k).catch(() => {})));
      return { item: { id, ...it, createdAt: prev.createdAt, updatedAt: now } };
    }
    if (m === 'DELETE') {
      await ref.delete().catch(dbError);
      const assets = (await CAPS).assets;
      await Promise.all(prev.images.map((k) => assets?.delete(k).catch(() => {})));
      return { ok: true };
    }
  }

  if (head === 'group' && m === 'POST') {
    const photos = Array.isArray(body?.photos) ? body.photos.filter((p) => p?.blob) : [];
    if (!photos.length) fail('사진이 없습니다.');
    return { groups: await groupWithAi(photos.slice(0, 30), await allItems(db)) };
  }

  if (head === 'analyze' && m === 'POST') {
    const key = String(body?.image || '');
    if (!key) fail('사진이 없습니다.');
    return { suggestion: await analyzeWithAi(key, await allItems(db)) };
  }

  if (head === 'images') {
    const assets = await need('assets');
    if (!id && m === 'POST') {
      try {
        const r = await assets.upload(raw);
        return { key: r.id };
      } catch (err) {
        if (err?.code === 'too_large') fail('사진이 너무 커요 (20MB까지).');
        if (err?.code === 'unsupported_type') fail('jpg, png, webp, gif 사진만 올릴 수 있어요.');
        if (err?.code === 'quota_or_state') fail('사진 저장 공간이 가득 찼어요.');
        fail('사진을 올리지 못했어요. 잠시 뒤 다시 해 주세요.', 502);
      }
    }
    if (id && m === 'DELETE') {
      await assets.delete(id).catch(() => {});
      return { ok: true };
    }
  }

  if (head === 'artists') {
    if (!id && m === 'GET') {
      const items = await allItems(db);
      const count = new Map();
      for (const it of items) if (it.artist) count.set(it.artist, (count.get(it.artist) || 0) + 1);
      const descs = await db.collection('artists').limit(1000).get().catch(dbError);
      const byName = new Map(descs.docs.filter((d) => d.exists).map((d) => [d.data().name, d.data()]));
      const artists = [...count.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'))
        .map(([name, n]) => {
          const a = byName.get(name) || {};
          return { name, count: n, description: a.description || '', sources: [], byAi: !!a.byAi, updatedAt: a.updatedAt || null };
        });
      return { artists };
    }
    const name = str(id, LIMITS.artist);
    if (!name) fail('작가 이름이 없습니다.');
    const ref = db.collection('artists').doc(await artistKey(name));
    if (!sub && m === 'PUT') {
      const description = str(body?.description, LIMITS.description);
      await ref.set({ name, description, byAi: false, updatedAt: Date.now() }).catch(dbError);
      return { artist: { name, description, sources: [], byAi: false } };
    }
    if (sub === 'ai' && m === 'POST') {
      const description = await describeWithAi(name, await allItems(db));
      await ref.set({ name, description, byAi: true, updatedAt: Date.now() }).catch(dbError);
      return { artist: { name, description, sources: [], byAi: true } };
    }
  }

  if (head === 'boards') {
    const col = db.collection('boards');
    if (!id && m === 'GET') {
      const snap = await col.orderBy('updatedAt', 'desc').limit(500).get().catch(dbError);
      return {
        boards: snap.docs.filter((d) => d.exists).map((d) => {
          const x = d.data();
          return { id: d.id, title: x.title, summary: x.summary || {}, createdAt: x.createdAt, updatedAt: x.updatedAt };
        }),
      };
    }
    if (!id && m === 'POST') {
      const now = Date.now();
      const title = str(body?.title, LIMITS.title) || '새 계획';
      const ref = col.doc();
      await ref.set({ title, data: {}, summary: boardSummary({}), createdAt: now, updatedAt: now }).catch(dbError);
      return { board: { id: ref.id, title, data: {}, createdAt: now, updatedAt: now } };
    }
    const ref = col.doc(id);
    const snap = await ref.get().catch(dbError);
    if (!snap.exists) fail('찾을 수 없습니다.', 404);
    const cur = snap.data();
    if (m === 'GET') return { board: { id, title: cur.title, data: cur.data || {}, createdAt: cur.createdAt, updatedAt: cur.updatedAt } };
    if (m === 'PUT') {
      const data = body?.data && typeof body.data === 'object' ? body.data : {};
      if (JSON.stringify(data).length > 240 * 1024) fail('그림이 너무 커요. 선을 조금 지우거나 새 계획으로 나눠 주세요.', 413);
      const now = Date.now();
      await ref.set({ title: str(body?.title, LIMITS.title) || '새 계획', data, summary: boardSummary(data), createdAt: cur.createdAt, updatedAt: now }).catch(dbError);
      const oldBg = cur.data?.bg;
      if (oldBg && oldBg !== data.bg) (await CAPS).assets?.delete(oldBg).catch(() => {});
      return { ok: true, updatedAt: now };
    }
    if (m === 'DELETE') {
      await ref.delete().catch(dbError);
      if (cur.data?.bg) (await CAPS).assets?.delete(cur.data.bg).catch(() => {});
      return { ok: true };
    }
  }

  fail('허용되지 않는 요청입니다.', 405);
}
