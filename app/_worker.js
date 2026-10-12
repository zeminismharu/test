/**
 * 레퍼런스 (아이디어 아카이브) 백엔드 — Cloudflare Pages · Advanced mode
 *
 * 모든 API를 이 파일 하나에 담고, API가 아닌 요청은 env.ASSETS 로 넘겨 정적 파일을 그대로 보여줍니다.
 *
 *   GET    /api/items                     공개. 모든 레퍼런스 (검색·필터는 화면에서 바로 처리)
 *   POST   /api/items                     로그인. 새 레퍼런스
 *   PUT    /api/items/:id                 로그인. 수정
 *   DELETE /api/items/:id                 로그인. 삭제 (사진도 같이 지움)
 *   POST   /api/images                    로그인. 사진 한 장 올리기 (본문 = 사진 파일)
 *   DELETE /api/images/:key               로그인. 올렸다가 취소한 사진 지우기
 *   GET    /img/:key                      공개. 사진 보기
 *   POST   /api/analyze  { image }        로그인. 사진을 보고 분류·제목·작가·태그 추천 (Gemini)
 *   GET    /api/artists                   공개. 작가 목록 + 설명
 *   PUT    /api/artists/:name             로그인. 작가 설명 직접 고치기
 *   POST   /api/artists/:name/ai          로그인. 구글 Gemini 로 작가 설명 만들기
 *   GET    /api/boards                    로그인. 작업 계획 보드 목록 (관리 화면)
 *   POST   /api/boards                    로그인. 새 보드
 *   GET    /api/boards/:id                로그인. 보드 하나 (그림·조명·할 일 전부)
 *   PUT    /api/boards/:id                로그인. 보드 저장
 *   DELETE /api/boards/:id                로그인. 보드 삭제
 *   POST   /api/login  { password }       세션 쿠키 발급
 *   POST   /api/logout
 *   GET    /api/session
 *
 * 필요한 설정 (배포 워크플로가 자동으로 연결합니다):
 *   D1 database  → DB
 *   KV namespace → IMAGES
 *   Secret       → ADMIN_PASSWORD (수정용 비밀번호), GEMINI_API_KEY (구글 AI 키)
 *                  ADMIN_PASSWORD 를 넣지 않으면 '열린 모드' — 비밀번호 없이 누구나 추가·수정·관리할 수 있습니다.
 *   선택         → GEMINI_MODEL (기본 gemini-3.6-flash), SESSION_SECRET
 */

const COOKIE_NAME = 'ref_session';
const SESSION_TTL = 60 * 60 * 24 * 30; // 30일
const DEFAULT_MODEL = 'gemini-3.6-flash';
const FALLBACK_MODEL = 'gemini-flash-latest';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES = 20;
// 분류: 전시관 · 영화 · 그 외 (화면에 보이는 순서)
const CATEGORIES = ['exhibition', 'movie', 'etc'];
const LIMITS = { place: 100, title: 200, artist: 100, memo: 10000, source: 1000, tag: 40, tags: 30, description: 5000 };

const encoder = new TextEncoder();
let schemaReady = false;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname.startsWith('/img/')) {
      return request.method === 'GET' ? serveImage(env, decodeURIComponent(pathname.slice(5))) : methodNotAllowed();
    }
    if (!pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    try {
      if (!env.DB) return json({ error: '데이터베이스(DB)가 연결되지 않았습니다.' }, 503);
      await ensureSchema(env);
      return await route(request, env, pathname.slice(5).split('/').map(decodeURIComponent));
    } catch (err) {
      console.error(err);
      return json({ error: '서버 오류가 났습니다. 잠시 뒤 다시 해 주세요.' }, 500);
    }
  },
};

async function route(request, env, parts) {
  const m = request.method;
  const [head, id, sub] = parts;

  if (head === 'session' && !id) return m === 'GET' ? json({ loggedIn: await isLoggedIn(request, env), open: !env.ADMIN_PASSWORD }) : methodNotAllowed();
  if (head === 'login' && !id) return m === 'POST' ? login(request, env) : methodNotAllowed();
  if (head === 'logout' && !id) return m === 'POST' ? logout() : methodNotAllowed();

  if (head === 'items') {
    if (!id) {
      if (m === 'GET') return listItems(env);
      if (m === 'POST') return (await requireLogin(request, env)) || createItem(request, env);
      return methodNotAllowed();
    }
    if (sub) return notFound();
    if (m === 'PUT') return (await requireLogin(request, env)) || updateItem(request, env, id);
    if (m === 'DELETE') return (await requireLogin(request, env)) || deleteItem(env, id);
    return methodNotAllowed();
  }

  if (head === 'images') {
    if (!id && m === 'POST') return (await requireLogin(request, env)) || uploadImage(request, env);
    if (id && !sub && m === 'DELETE') return (await requireLogin(request, env)) || deleteImage(env, id);
    return methodNotAllowed();
  }

  if (head === 'analyze' && !id) {
    return m === 'POST' ? (await requireLogin(request, env)) || analyzeImage(request, env) : methodNotAllowed();
  }

  if (head === 'artists') {
    if (!id) return m === 'GET' ? listArtists(env) : methodNotAllowed();
    if (!sub && m === 'PUT') return (await requireLogin(request, env)) || saveArtist(request, env, id);
    if (sub === 'ai' && m === 'POST') return (await requireLogin(request, env)) || describeArtist(env, id);
    return methodNotAllowed();
  }

  if (head === 'boards') {
    const denied = await requireLogin(request, env);
    if (denied) return denied;
    if (sub) return notFound();
    if (!id) {
      if (m === 'GET') return listBoards(env);
      if (m === 'POST') return createBoard(request, env);
      return methodNotAllowed();
    }
    if (m === 'GET') return getBoard(env, id);
    if (m === 'PUT') return saveBoard(request, env, id);
    if (m === 'DELETE') return deleteBoard(env, id);
    return methodNotAllowed();
  }

  return notFound();
}

/* ─────────────── 데이터베이스 ─────────────── */

async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      artist TEXT NOT NULL DEFAULT '',
      memo TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT '',
      images TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS items_artist ON items(artist)'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS artists (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      sources TEXT NOT NULL DEFAULT '[]',
      by_ai INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS boards (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      data TEXT NOT NULL DEFAULT '{}',
      summary TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
  ]);
  // 2026-10 분류(전시관·영화·그 외) 칸 추가. 이미 있으면 오류가 나므로 무시합니다.
  await env.DB.prepare("ALTER TABLE items ADD COLUMN category TEXT NOT NULL DEFAULT 'etc'").run().catch(() => {});
  // 2026-10 전시관 이름(본 곳·장소) 칸 추가
  await env.DB.prepare("ALTER TABLE items ADD COLUMN place TEXT NOT NULL DEFAULT ''").run().catch(() => {});
  schemaReady = true;
}

function rowToItem(r) {
  return {
    id: r.id,
    title: r.title,
    artist: r.artist,
    category: CATEGORIES.includes(r.category) ? r.category : 'etc',
    place: r.place || '',
    memo: r.memo,
    tags: safeParse(r.tags, []),
    source: r.source,
    images: safeParse(r.images, []),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function listItems(env) {
  const { results } = await env.DB.prepare('SELECT * FROM items ORDER BY created_at DESC').all();
  return json({ items: results.map(rowToItem) });
}

function cleanItem(body) {
  const str = (v, max) => String(v ?? '').trim().slice(0, max);
  const tags = [...new Set((Array.isArray(body.tags) ? body.tags : [])
    .map((t) => str(t, LIMITS.tag).replace(/^#/, ''))
    .filter(Boolean))].slice(0, LIMITS.tags);
  const images = (Array.isArray(body.images) ? body.images : [])
    .map(String)
    .filter((k) => /^[a-z0-9-]{8,64}$/.test(k))
    .slice(0, MAX_IMAGES);
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

async function createItem(request, env) {
  const body = await readJson(request);
  if (!body) return json({ error: '잘못된 요청입니다.' }, 400);
  const it = cleanItem(body);
  if (!it.title && !it.images.length && !it.memo) return json({ error: '제목, 사진, 메모 중 하나는 있어야 합니다.' }, 400);
  it.artist = await canonicalArtist(env, it.artist);
  const now = Date.now();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO items (id, title, artist, category, place, memo, tags, source, images, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, it.title, it.artist, it.category, it.place, it.memo, JSON.stringify(it.tags), it.source, JSON.stringify(it.images), now, now).run();
  const row = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
  return json({ item: rowToItem(row) }, 201);
}

async function updateItem(request, env, id) {
  const body = await readJson(request);
  if (!body) return json({ error: '잘못된 요청입니다.' }, 400);
  const old = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
  if (!old) return notFound();
  const it = cleanItem(body);
  if (!it.title && !it.images.length && !it.memo) return json({ error: '제목, 사진, 메모 중 하나는 있어야 합니다.' }, 400);
  it.artist = await canonicalArtist(env, it.artist, id);
  await env.DB.prepare(
    'UPDATE items SET title = ?, artist = ?, category = ?, place = ?, memo = ?, tags = ?, source = ?, images = ?, updated_at = ? WHERE id = ?'
  ).bind(it.title, it.artist, it.category, it.place, it.memo, JSON.stringify(it.tags), it.source, JSON.stringify(it.images), Date.now(), id).run();
  // 수정하면서 뺀 사진은 저장소에서도 지웁니다.
  const removed = safeParse(old.images, []).filter((k) => !it.images.includes(k));
  await Promise.all(removed.map((k) => env.IMAGES?.delete(k)));
  const row = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
  return json({ item: rowToItem(row) });
}

async function deleteItem(env, id) {
  const old = await env.DB.prepare('SELECT images FROM items WHERE id = ?').bind(id).first();
  if (!old) return notFound();
  await env.DB.prepare('DELETE FROM items WHERE id = ?').bind(id).run();
  await Promise.all(safeParse(old.images, []).map((k) => env.IMAGES?.delete(k)));
  return json({ ok: true });
}

/* ─────────────── 사진 ─────────────── */

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

async function uploadImage(request, env) {
  if (!env.IMAGES) return json({ error: '사진 저장소(IMAGES)가 연결되지 않았습니다.' }, 503);
  const type = (request.headers.get('content-type') || '').split(';')[0].trim();
  if (!IMAGE_TYPES.includes(type)) return json({ error: '사진 파일(jpg, png, webp, gif)만 올릴 수 있습니다.' }, 415);
  const buf = await request.arrayBuffer();
  if (!buf.byteLength) return json({ error: '빈 파일입니다.' }, 400);
  if (buf.byteLength > MAX_IMAGE_BYTES) return json({ error: '사진이 너무 큽니다 (8MB까지).' }, 413);
  const key = crypto.randomUUID();
  await env.IMAGES.put(key, buf, { metadata: { type } });
  return json({ key }, 201);
}

async function deleteImage(env, key) {
  // 이미 레퍼런스에 쓰이고 있는 사진은 이 길로 지우지 않습니다.
  const used = await env.DB.prepare('SELECT 1 FROM items WHERE images LIKE ? LIMIT 1').bind(`%"${key}"%`).first();
  const usedByBoard = await env.DB.prepare('SELECT 1 FROM boards WHERE data LIKE ? LIMIT 1').bind(`%"${key}"%`).first();
  if (used || usedByBoard) return json({ error: '사용 중인 사진입니다.' }, 409);
  await env.IMAGES?.delete(key);
  return json({ ok: true });
}

async function serveImage(env, key) {
  if (!env.IMAGES || !/^[a-z0-9-]{8,64}$/.test(key)) return new Response('Not found', { status: 404 });
  const { value, metadata } = await env.IMAGES.getWithMetadata(key, 'arrayBuffer');
  if (!value) return new Response('Not found', { status: 404 });
  return new Response(value, {
    headers: {
      'content-type': metadata?.type || 'image/jpeg',
      // 사진 이름은 매번 새로 만들어지므로 오래 저장해 둬도 안전합니다.
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    },
  });
}

/* ─────────────── 작가 ─────────────── */

async function listArtists(env) {
  const { results } = await env.DB.prepare(`
    SELECT i.artist AS name, COUNT(*) AS count, MAX(i.created_at) AS last_at,
           a.description, a.sources, a.by_ai, a.updated_at
    FROM items i LEFT JOIN artists a ON a.name = i.artist
    WHERE i.artist != ''
    GROUP BY i.artist
    ORDER BY count DESC, name ASC
  `).all();
  return json({
    artists: results.map((r) => ({
      name: r.name,
      count: r.count,
      description: r.description || '',
      sources: safeParse(r.sources, []),
      byAi: !!r.by_ai,
      updatedAt: r.updated_at || null,
    })),
  });
}

async function saveArtist(request, env, name) {
  name = String(name).trim().slice(0, LIMITS.artist);
  if (!name) return json({ error: '작가 이름이 없습니다.' }, 400);
  const body = await readJson(request);
  if (!body) return json({ error: '잘못된 요청입니다.' }, 400);
  const description = String(body.description ?? '').trim().slice(0, LIMITS.description);
  await upsertArtist(env, name, description, [], false);
  return json({ artist: { name, description, sources: [], byAi: false } });
}

async function upsertArtist(env, name, description, sources, byAi) {
  await env.DB.prepare(`
    INSERT INTO artists (name, description, sources, by_ai, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET description = excluded.description, sources = excluded.sources,
      by_ai = excluded.by_ai, updated_at = excluded.updated_at
  `).bind(name, description, JSON.stringify(sources), byAi ? 1 : 0, Date.now()).run();
}

async function describeArtist(env, name) {
  name = String(name).trim().slice(0, LIMITS.artist);
  if (!name) return json({ error: '작가 이름이 없습니다.' }, 400);
  if (!env.GEMINI_API_KEY) return json({ error: '구글 AI 키(GEMINI_API_KEY)가 설정되지 않았습니다.' }, 503);

  // 동명이인을 구분할 수 있도록, 이 작가로 저장된 레퍼런스 제목과 태그를 같이 알려줍니다.
  const { results } = await env.DB.prepare(
    'SELECT title, tags FROM items WHERE artist = ? ORDER BY created_at DESC LIMIT 15'
  ).bind(name).all();
  const titles = results.map((r) => r.title).filter(Boolean);
  const tags = [...new Set(results.flatMap((r) => safeParse(r.tags, [])))].slice(0, 20);

  const prompt = [
    `"${name}"라는 작가(아티스트·디자이너·작가 등 창작자)를 한국어로 간단히 소개해 주세요.`,
    titles.length ? `참고: 사용자가 이 작가의 작품으로 저장한 것 — ${titles.join(', ')}` : '',
    tags.length ? `참고 태그: ${tags.join(', ')}` : '',
    '',
    '형식:',
    '- 첫 줄: 한 문장 요약 (어느 나라, 어떤 분야, 언제 활동)',
    '- 그다음 3~5줄: 대표 작품, 스타일·특징, 왜 레퍼런스로 볼 만한지',
    '- 마크다운 기호(#, *, **) 없이 평범한 문장으로, 한 줄에 한 문장.',
    '',
    '중요: 확실하지 않은 사실은 지어내지 마세요. 어떤 사람인지 찾을 수 없거나 동명이인이 여럿이라 특정할 수 없으면',
    '"정확한 정보를 찾지 못했습니다."라고 쓰고, 알 수 있는 범위만 짧게 적어 주세요.',
  ].filter((l) => l !== null).join('\n');

  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  // 구글 검색을 붙여서 먼저 시도하고, 안 되면 검색 없이, 그래도 안 되면 다른 모델로 시도합니다.
  const attempts = [
    { model, search: true },
    { model, search: false },
    ...(model !== FALLBACK_MODEL ? [{ model: FALLBACK_MODEL, search: true }, { model: FALLBACK_MODEL, search: false }] : []),
  ];
  let lastError = '';
  for (const a of attempts) {
    const res = await callGemini(env.GEMINI_API_KEY, a.model, prompt, a.search);
    if (res.text) {
      const description = res.text.trim().slice(0, LIMITS.description);
      await upsertArtist(env, name, description, res.sources, true);
      return json({ artist: { name, description, sources: res.sources, byAi: true, model: a.model } });
    }
    lastError = res.error;
    if (res.status === 400 && /API key/i.test(res.error)) break; // 키가 틀리면 더 시도해도 소용없음
    if (res.status === 429) break;
  }
  return json({ error: `AI 설명을 만들지 못했습니다. ${lastError}`.trim() }, 502);
}

/* ─────────────── 사진 자동 분류 ─────────────── */

// 이미 있는 작가와 띄어쓰기·대소문자만 다르면 이미 있는 이름으로 맞춥니다. (작가별로 한곳에 모이도록)
async function canonicalArtist(env, name, exceptId = '') {
  if (!name) return '';
  const { results } = await env.DB.prepare("SELECT DISTINCT artist FROM items WHERE artist != '' AND id != ?").bind(exceptId).all();
  return matchArtist(name, results.map((r) => r.artist));
}

// 같은 작가인지 비교할 때 띄어쓰기·기호·대소문자는 무시합니다. (제임스 터렐 = 제임스터렐)
function artistKeyOf(name) {
  return String(name || '').toLowerCase().normalize('NFC').replace(/[\s.\-_·'"()]/g, '');
}

function matchArtist(name, existing) {
  const k = artistKeyOf(name);
  if (!k) return '';
  return existing.find((e) => artistKeyOf(e) === k) || name.trim().slice(0, LIMITS.artist);
}

function analyzePrompt(existing) {
  return [
    '이 사진은 사용자가 아이디어 아카이브에 모으는 레퍼런스입니다. 사진을 보고 아래를 JSON 하나로만 답하세요.',
    '',
    '- category: "exhibition"(전시·미술관·갤러리·설치작품·작품 사진·전시 포스터), "movie"(영화 장면·스틸컷·영화 포스터·드라마), "etc"(그 외 전부) 중 하나',
    '- title: 사진을 알아볼 수 있는 짧은 한국어 제목 (작품명·영화 제목을 알면 그것, 모르면 무엇이 보이는지)',
    '- artist: 작가·감독·디자이너 이름. 확실할 때만 쓰고, 모르면 빈 문자열 ""',
    '- place: 전시관·미술관·갤러리 이름(전시일 때), 사진에 글자로 보이거나 확실할 때만. 모르면 ""',
    '- tags: 한국어 태그 2~5개 (예: 조명, 색감, 공간, 타이포그래피)',
    '- memo: 사진에서 눈여겨볼 점 한두 문장 (한국어)',
    '',
    '작가 이름 규칙:',
    existing.length
      ? `- 사용자가 이미 저장한 작가: ${existing.slice(0, 300).join(', ')}`
      : '- 아직 저장된 작가가 없습니다.',
    '- 위 목록에 같은 사람이 있으면(영어·한국어 표기가 달라도) 반드시 목록에 적힌 이름을 글자 그대로 쓰세요.',
    '- 목록에 없는 새 작가면 한국에서 흔히 쓰는 한국어 표기로 쓰세요.',
    '- 추측하지 마세요. 확실하지 않으면 artist 는 "" 입니다.',
  ].join('\n');
}

function cleanAnalysis(raw, existing) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const tags = (Array.isArray(o.tags) ? o.tags : []).map((t) => String(t).replace(/^#/, '').trim().slice(0, LIMITS.tag)).filter(Boolean).slice(0, 5);
  return {
    category: CATEGORIES.includes(o.category) ? o.category : 'etc',
    title: String(o.title || '').trim().slice(0, LIMITS.title),
    artist: matchArtist(String(o.artist || ''), existing),
    place: String(o.place || '').trim().slice(0, LIMITS.place),
    tags,
    memo: String(o.memo || '').trim().slice(0, 500),
  };
}

function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch { /* 아래에서 다시 */ }
  const m = String(text).match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* 실패 */ } }
  return null;
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function analyzeImage(request, env) {
  if (!env.GEMINI_API_KEY) return json({ error: '구글 AI 키(GEMINI_API_KEY)가 설정되지 않았습니다.' }, 503);
  if (!env.IMAGES) return json({ error: '사진 저장소(IMAGES)가 연결되지 않았습니다.' }, 503);
  const body = await readJson(request);
  const key = String(body?.image || '');
  if (!/^[a-z0-9-]{8,64}$/.test(key)) return json({ error: '사진이 없습니다.' }, 400);
  const { value, metadata } = await env.IMAGES.getWithMetadata(key, 'arrayBuffer');
  if (!value) return json({ error: '사진을 찾을 수 없습니다.' }, 404);

  const { results } = await env.DB.prepare("SELECT artist, COUNT(*) AS n FROM items WHERE artist != '' GROUP BY artist ORDER BY n DESC").all();
  const existing = results.map((r) => r.artist);

  const parts = [{ text: analyzePrompt(existing) }, { inlineData: { mimeType: metadata?.type || 'image/jpeg', data: toBase64(value) } }];
  const schema = {
    type: 'OBJECT',
    properties: {
      category: { type: 'STRING', enum: CATEGORIES },
      title: { type: 'STRING' },
      artist: { type: 'STRING' },
      place: { type: 'STRING' },
      tags: { type: 'ARRAY', items: { type: 'STRING' } },
      memo: { type: 'STRING' },
    },
    required: ['category', 'title', 'artist', 'tags'],
  };
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  // 정해진 모양(JSON)으로 먼저 묻고, 안 되면 모양 없이, 그래도 안 되면 다른 모델로 묻습니다.
  const attempts = [
    { model, schema: true },
    { model, schema: false },
    ...(model !== FALLBACK_MODEL ? [{ model: FALLBACK_MODEL, schema: false }] : []),
  ];
  let lastError = '';
  for (const a of attempts) {
    const generationConfig = { responseMimeType: 'application/json' };
    if (a.schema) generationConfig.responseSchema = schema;
    const res = await geminiRequest(env.GEMINI_API_KEY, a.model, { contents: [{ role: 'user', parts }], generationConfig });
    if (res.text) {
      const parsed = parseJsonLoose(res.text);
      if (parsed) return json({ suggestion: cleanAnalysis(parsed, existing), model: a.model });
      lastError = 'AI 답을 읽지 못했습니다.';
      continue;
    }
    lastError = res.error;
    if (res.status === 429 || (res.status === 400 && /API key/i.test(res.error))) break;
  }
  return json({ error: `사진을 분석하지 못했습니다. ${lastError}`.trim() }, 502);
}

async function geminiRequest(apiKey, model, body) {
  let res;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
  } catch {
    return { error: '구글 AI에 연결하지 못했습니다.', status: 0 };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    return { error: res.status === 429 ? '구글 AI 사용량 한도에 걸렸습니다. 잠시 뒤 다시 해 주세요.' : msg, status: res.status };
  }
  const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  return text ? { text, status: res.status } : { error: '구글 AI가 빈 답을 보냈습니다.', status: res.status };
}

async function callGemini(apiKey, model, prompt, withSearch) {
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
  if (withSearch) body.tools = [{ google_search: {} }];
  let res;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { error: '구글 AI에 연결하지 못했습니다.', status: 0 };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    return { error: res.status === 429 ? '구글 AI 사용량 한도에 걸렸습니다. 잠시 뒤 다시 해 주세요.' : msg, status: res.status };
  }
  const cand = data?.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!text) return { error: '구글 AI가 빈 답을 보냈습니다.', status: res.status };
  const sources = [];
  for (const c of cand?.groundingMetadata?.groundingChunks || []) {
    if (c.web?.uri && !sources.some((s) => s.uri === c.web.uri)) sources.push({ uri: c.web.uri, title: c.web.title || c.web.uri });
  }
  return { text: text.replace(/\*\*/g, ''), sources: sources.slice(0, 6) };
}

/* ─────────────── 작업 계획 보드 (관리 화면) ─────────────── */

const BOARD_MAX_BYTES = 900 * 1024; // D1 한 칸에 넉넉히 들어가는 크기

function boardSummary(data) {
  const lights = Array.isArray(data.lights) ? data.lights : [];
  const todos = Array.isArray(data.todos) ? data.todos : [];
  return {
    lights: lights.length,
    kelvins: [...new Set(lights.map((l) => Number(l.k)).filter(Number.isFinite))].sort((a, b) => a - b).slice(0, 8),
    todos: todos.length,
    done: todos.filter((t) => t.done).length,
    strokes: Array.isArray(data.strokes) ? data.strokes.length : 0,
    bg: typeof data.bg === 'string' ? data.bg : null,
  };
}

async function listBoards(env) {
  const { results } = await env.DB.prepare('SELECT id, title, summary, created_at, updated_at FROM boards ORDER BY updated_at DESC').all();
  return json({
    boards: results.map((r) => ({ id: r.id, title: r.title, summary: safeParse(r.summary, {}), createdAt: r.created_at, updatedAt: r.updated_at })),
  });
}

async function createBoard(request, env) {
  const body = (await readJson(request)) || {};
  const id = crypto.randomUUID();
  const now = Date.now();
  const title = String(body.title ?? '').trim().slice(0, LIMITS.title) || '새 계획';
  await env.DB.prepare('INSERT INTO boards (id, title, data, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, title, '{}', JSON.stringify(boardSummary({})), now, now).run();
  return json({ board: { id, title, data: {}, createdAt: now, updatedAt: now } }, 201);
}

async function getBoard(env, id) {
  const r = await env.DB.prepare('SELECT * FROM boards WHERE id = ?').bind(id).first();
  if (!r) return notFound();
  return json({ board: { id: r.id, title: r.title, data: safeParse(r.data, {}), createdAt: r.created_at, updatedAt: r.updated_at } });
}

async function saveBoard(request, env, id) {
  const text = await request.text();
  if (text.length > BOARD_MAX_BYTES + 2000) return json({ error: '그림이 너무 커요. 선을 조금 지우거나 새 보드로 나눠 주세요.' }, 413);
  const body = safeParse(text, null);
  if (!body || typeof body !== 'object') return json({ error: '잘못된 요청입니다.' }, 400);
  const data = body.data && typeof body.data === 'object' ? body.data : {};
  const dataText = JSON.stringify(data);
  if (dataText.length > BOARD_MAX_BYTES) return json({ error: '그림이 너무 커요. 선을 조금 지우거나 새 보드로 나눠 주세요.' }, 413);
  const title = String(body.title ?? '').trim().slice(0, LIMITS.title) || '새 계획';
  const now = Date.now();
  const old = await env.DB.prepare('SELECT data FROM boards WHERE id = ?').bind(id).first();
  if (!old) return notFound();
  await env.DB.prepare('UPDATE boards SET title = ?, data = ?, summary = ?, updated_at = ? WHERE id = ?')
    .bind(title, dataText, JSON.stringify(boardSummary(data)), now, id).run();
  // 배경 사진을 바꿨으면 예전 사진은 지웁니다.
  const oldBg = safeParse(old.data, {}).bg;
  if (oldBg && oldBg !== data.bg) await env.IMAGES?.delete(oldBg);
  return json({ ok: true, updatedAt: now });
}

async function deleteBoard(env, id) {
  const old = await env.DB.prepare('SELECT data FROM boards WHERE id = ?').bind(id).first();
  if (!old) return notFound();
  await env.DB.prepare('DELETE FROM boards WHERE id = ?').bind(id).run();
  const bg = safeParse(old.data, {}).bg;
  if (bg) await env.IMAGES?.delete(bg);
  return json({ ok: true });
}

/* ─────────────── 로그인 ─────────────── */

async function sessionKey(env) {
  const secret = env.SESSION_SECRET || `ref:${env.ADMIN_PASSWORD}`;
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sign(env, payload) {
  return b64url(await crypto.subtle.sign('HMAC', await sessionKey(env), encoder.encode(payload)));
}

async function isLoggedIn(request, env) {
  if (!env.ADMIN_PASSWORD) return true; // 열린 모드: 비밀번호가 없으면 누구나 수정 가능
  const cookie = request.headers.get('cookie') || '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!match) return false;
  const [exp, sig] = match[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  return timingSafeEqual(sig, await sign(env, exp));
}

async function requireLogin(request, env) {
  if (await isLoggedIn(request, env)) return null;
  return json({ error: '로그인이 필요합니다.' }, 401);
}

async function login(request, env) {
  if (!env.ADMIN_PASSWORD) return json({ ok: true, open: true });
  const body = await readJson(request);
  const given = String(body?.password ?? '');
  // 길이가 달라도 비교 시간이 같도록 해시끼리 비교합니다.
  const [a, b] = await Promise.all([given, env.ADMIN_PASSWORD].map((s) => crypto.subtle.digest('SHA-256', encoder.encode(s))));
  if (!timingSafeEqual(b64url(a), b64url(b))) {
    await new Promise((r) => setTimeout(r, 600));
    return json({ error: '비밀번호가 맞지 않습니다.' }, 401);
  }
  const exp = String(Math.floor(Date.now() / 1000) + SESSION_TTL);
  const value = `${exp}.${await sign(env, exp)}`;
  return json({ ok: true }, 200, {
    'set-cookie': `${COOKIE_NAME}=${value}; Path=/; Max-Age=${SESSION_TTL}; HttpOnly; Secure; SameSite=Strict`,
  });
}

function logout() {
  return json({ ok: true }, 200, { 'set-cookie': `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` });
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ─────────────── 도우미 ─────────────── */

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

async function readJson(request) {
  try {
    const v = await request.json();
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function safeParse(s, fallback) {
  try {
    return JSON.parse(s) ?? fallback;
  } catch {
    return fallback;
  }
}

const notFound = () => json({ error: '찾을 수 없습니다.' }, 404);
const methodNotAllowed = () => json({ error: '허용되지 않는 요청입니다.' }, 405);
