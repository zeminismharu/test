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
 *   GET    /api/venues/:name              공개. 저장해 둔 전시관 정보 (주소·운영시간·휴관일·지금 하는 전시)
 *   POST   /api/venues/:name/refresh      로그인. 구글 검색으로 전시관 정보를 새로 찾기 (Gemini)
 *   GET    /api/todo                      공개. 가볼 곳 목록 (처음 한 번은 사장님이 준 목록으로 채움)
 *   POST   /api/todo  { name, area }      로그인. 가볼 곳 추가
 *   PUT    /api/todo/:id { done }         로그인. 직접 '다녀옴' 표시
 *   DELETE /api/todo/:id                  로그인. 빼기
 *   POST   /api/items/merge { ids, keep }  로그인. 같은 관람 항목 합치기
 *   POST   /api/items/:id/move { image, to } 로그인. 사진 한 장을 다른 항목으로
 *   GET    /api/export · POST /api/import  로그인. 백업 받기 · 되살리기
 *   GET/POST/PUT/DELETE /api/wish          보고 싶은 전시 (쓰기는 로그인)
 *   GET    /api/stats                     공개. 오늘·이번 달 AI 사용량과 하루 한도 (첫 화면 게임 카드)
 *   POST   /api/water                     로그인. 첫 화면 화분에 오늘 물 주기 (하루 한 번, 서버에 저장 → 어느 기기에서나 같음)
 *   PUT    /api/settings                  로그인. { aiDailyTokens, aiDailyRequests } 하루 한도 정하기
 *   POST   /api/group    { photos }       로그인. 여러 장을 같이 보고 같은 관람(같은 전시·영화)끼리 묶기
 *   GET    /api/artists                   공개. 작가 목록 + 설명
 *   PUT    /api/artists/:name             로그인. 작가 설명 직접 고치기
 *   POST   /api/artists/:name/ai          로그인. 구글 Gemini 로 작가 설명 + 대표작 2점(그림 파일) 만들기
 *   PUT    /api/artists/:name/works       로그인. 대표작 고치기 (사진 바꾸기 등)
 *   POST   /api/artists/auto              로그인. 소개·대표작이 비어 있는 작가 한 명 채우기 (매일 GitHub Actions 가 부름)
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
// 무료 한도는 모델마다 따로라서(2026-10 AI Studio: 3.6 Flash·3.8 Flash 각각 분당 5회·하루 20회),
// 기본 모델이 한도(429)나 붐빔(5xx)에 걸리면 다른 모델로 넘어갑니다.
const FALLBACK_MODEL = 'gemini-3.8-flash';
// 앱이 먼저 쉬는 기본 한도 (첫 화면 카드에서 바꿀 수 있음). 두 모델을 합쳐 하루 40회 중 여유를 둠.
const DEFAULT_LIMITS = { aiRpm: 4, aiDailyRequests: 36 };
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES = 60; // 한 관람에 사진이 많아 합칠 수 있도록
// 분류: 전시관 · 영화 · 그 외 (화면에 보이는 순서)
const CATEGORIES = ['exhibition', 'movie', 'etc'];
const LIMITS = { place: 100, title: 200, artist: 100, memo: 10000, source: 1000, tag: 40, tags: 30, description: 5000 };

const encoder = new TextEncoder();
const str = (v, max) => String(v ?? '').trim().slice(0, max);
let schemaReady = false;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname.startsWith('/img/')) {
      return request.method === 'GET' ? serveImage(env, decodeURIComponent(pathname.slice(5))) : methodNotAllowed();
    }
    if (!pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    try {
      if (!env.DB) return json({ error: '데이터베이스(DB)가 연결되지 않았습니다.' }, 503);
      await ensureSchema(env);
      return await route(request, env, pathname.slice(5).split('/').map(decodeURIComponent), ctx);
    } catch (err) {
      console.error(err);
      return json({ error: '서버 오류가 났습니다. 잠시 뒤 다시 해 주세요.' }, 500);
    }
  },
};

async function route(request, env, parts, ctx) {
  const m = request.method;
  const [head, id, sub] = parts;

  if (head === 'session' && !id) return m === 'GET' ? json({ loggedIn: await isLoggedIn(request, env), open: !env.ADMIN_PASSWORD }) : methodNotAllowed();
  if (head === 'login' && !id) return m === 'POST' ? login(request, env) : methodNotAllowed();
  if (head === 'logout' && !id) return m === 'POST' ? logout() : methodNotAllowed();

  if (head === 'items') {
    if (!id) {
      if (m === 'GET') return listItems(env);
      if (m === 'POST') return (await requireLogin(request, env)) || createItem(request, env, ctx);
      return methodNotAllowed();
    }
    if (id === 'merge' && !sub && m === 'POST') return (await requireLogin(request, env)) || mergeItems(request, env);
    if (sub === 'move' && m === 'POST') return (await requireLogin(request, env)) || movePhoto(request, env, id);
    if (sub) return notFound();
    if (m === 'PUT') return (await requireLogin(request, env)) || updateItem(request, env, id, ctx);
    if (m === 'DELETE') return (await requireLogin(request, env)) || deleteItem(env, id);
    return methodNotAllowed();
  }

  if (head === 'export' && !id) return m === 'GET' ? (await requireLogin(request, env)) || exportAll(env) : methodNotAllowed();
  if (head === 'import' && !id) return m === 'POST' ? (await requireLogin(request, env)) || importAll(request, env) : methodNotAllowed();

  if (head === 'wish') {
    if (sub) return notFound();
    if (!id && m === 'GET') return listWish(env);
    if (!id && m === 'POST') return (await requireLogin(request, env)) || addWish(request, env);
    if (id && m === 'PUT') return (await requireLogin(request, env)) || updateWish(request, env, id);
    if (id && m === 'DELETE') return (await requireLogin(request, env)) || deleteWish(env, id);
    return methodNotAllowed();
  }

  if (head === 'images') {
    if (!id && m === 'POST') return (await requireLogin(request, env)) || uploadImage(request, env);
    if (id && !sub && m === 'DELETE') return (await requireLogin(request, env)) || deleteImage(env, id);
    return methodNotAllowed();
  }

  if (head === 'venues' && !id && m === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM venues').all();
    return json({ venues: results.map((r) => ({ name: r.name, info: safeParse(r.info, {}), sources: safeParse(r.sources, []), updatedAt: r.updated_at })) });
  }
  if (head === 'venues' && id) {
    if (!sub && m === 'GET') return getVenue(env, id);
    if (sub === 'refresh' && m === 'POST') return (await requireLogin(request, env)) || refreshVenue(env, id);
    return methodNotAllowed();
  }

  if (head === 'todo') {
    if (sub) return notFound();
    if (!id && m === 'GET') return listTodo(env);
    if (!id && m === 'POST') return (await requireLogin(request, env)) || addTodo(request, env);
    if (id && m === 'PUT') return (await requireLogin(request, env)) || updateTodo(request, env, id);
    if (id && m === 'DELETE') return (await requireLogin(request, env)) || deleteTodo(env, id);
    return methodNotAllowed();
  }

  if (head === 'stats' && !id) return m === 'GET' ? getStats(env) : methodNotAllowed();
  if (head === 'water' && !id) {
    return m === 'POST' ? (await requireLogin(request, env)) || waterPlant(env) : methodNotAllowed();
  }
  if (head === 'settings' && !id) {
    return m === 'PUT' ? (await requireLogin(request, env)) || saveSettings(request, env) : methodNotAllowed();
  }

  if (head === 'group' && !id) {
    return m === 'POST' ? (await requireLogin(request, env)) || groupPhotos(request, env) : methodNotAllowed();
  }

  if (head === 'analyze' && !id) {
    return m === 'POST' ? (await requireLogin(request, env)) || analyzeImage(request, env) : methodNotAllowed();
  }

  if (head === 'artists') {
    if (!id) return m === 'GET' ? listArtists(env) : methodNotAllowed();
    if (id === 'auto' && !sub) return m === 'POST' ? (await requireLogin(request, env)) || autoArtists(env) : methodNotAllowed();
    if (sub === 'works' && m === 'PUT') return (await requireLogin(request, env)) || saveWorks(request, env, id);
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
    env.DB.prepare('CREATE TABLE IF NOT EXISTS ai_usage (day TEXT PRIMARY KEY, requests INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0)'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS venues (
      name TEXT PRIMARY KEY,
      info TEXT NOT NULL DEFAULT '{}',
      sources TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS todo_places (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      area TEXT NOT NULL DEFAULT '',
      keys TEXT NOT NULL DEFAULT '[]',
      done INTEGER NOT NULL DEFAULT 0,
      sort INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS analysis (image TEXT PRIMARY KEY, result TEXT NOT NULL, created_at INTEGER NOT NULL)'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS wish (
      id TEXT PRIMARY KEY,
      venue TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      period TEXT NOT NULL DEFAULT '',
      artist TEXT NOT NULL DEFAULT '',
      ends TEXT NOT NULL DEFAULT '',
      done INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)'),
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
  // 2026-10 관람일 (사진 찍은 날). 0 이면 모름 → 화면에서 작성일을 씀
  await env.DB.prepare('ALTER TABLE items ADD COLUMN visited_at INTEGER NOT NULL DEFAULT 0').run().catch(() => {});
  // 2026-10 작가 대표작 2점 [{ title, titleKo, year, note, image(사진 키), imageFrom, page }]
  // 비어 있으면(NULL) 아직 한 번도 찾아보지 않은 작가 → 자동 채우기 대상
  await env.DB.prepare('ALTER TABLE artists ADD COLUMN works TEXT').run().catch(() => {});
  schemaReady = true;
}

function rowToItem(r) {
  return {
    id: r.id,
    title: r.title,
    artist: r.artist,
    category: CATEGORIES.includes(r.category) ? r.category : 'etc',
    place: r.place || '',
    visitedAt: r.visited_at || 0,
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

// 관람일: 2000년 ~ 내일 사이의 시각(ms)만 받습니다.
function validTime(v) {
  const n = Math.floor(Number(v) || 0);
  return n > 946684800000 && n < Date.now() + 86400000 ? n : 0;
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
    visitedAt: validTime(body.visitedAt),
    memo: str(body.memo, LIMITS.memo),
    source: str(body.source, LIMITS.source),
    tags,
    images,
  };
}

async function createItem(request, env, ctx) {
  const body = await readJson(request);
  if (!body) return json({ error: '잘못된 요청입니다.' }, 400);
  const it = cleanItem(body);
  if (!it.title && !it.images.length && !it.memo) return json({ error: '제목, 사진, 메모 중 하나는 있어야 합니다.' }, 400);
  it.artist = await canonicalArtist(env, it.artist);
  const now = Date.now();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO items (id, title, artist, category, place, visited_at, memo, tags, source, images, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, it.title, it.artist, it.category, it.place, it.visitedAt, it.memo, JSON.stringify(it.tags), it.source, JSON.stringify(it.images), now, now).run();
  const row = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
  queueArtist(env, ctx, it.artist);
  return json({ item: rowToItem(row) }, 201);
}

async function updateItem(request, env, id, ctx) {
  const body = await readJson(request);
  if (!body) return json({ error: '잘못된 요청입니다.' }, 400);
  const old = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
  if (!old) return notFound();
  const it = cleanItem(body);
  if (!it.title && !it.images.length && !it.memo) return json({ error: '제목, 사진, 메모 중 하나는 있어야 합니다.' }, 400);
  it.artist = await canonicalArtist(env, it.artist, id);
  await env.DB.prepare(
    'UPDATE items SET title = ?, artist = ?, category = ?, place = ?, visited_at = ?, memo = ?, tags = ?, source = ?, images = ?, updated_at = ? WHERE id = ?'
  ).bind(it.title, it.artist, it.category, it.place, it.visitedAt, it.memo, JSON.stringify(it.tags), it.source, JSON.stringify(it.images), Date.now(), id).run();
  // 수정하면서 뺀 사진은 저장소에서도 지웁니다.
  const removed = safeParse(old.images, []).filter((k) => !it.images.includes(k));
  await Promise.all(removed.map((k) => env.IMAGES?.delete(k)));
  if (it.artist !== old.artist) queueArtist(env, ctx, it.artist);
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
           a.description, a.sources, a.by_ai, a.updated_at, a.works
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
      works: safeParse(r.works, []),
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
  const r = await fillArtist(env, name);
  return r.error ? json({ error: r.error }, r.status || 502) : json({ artist: r.artist });
}

// 작가 소개 + 대표작 2점을 구글 검색으로 찾고, 대표작 그림은 내려받아 사진 저장소에 넣습니다.
// AI 한 번만 부릅니다 (무료 한도 아끼기).
async function fillArtist(env, name, keepManual = false) {
  if (!env.GEMINI_API_KEY) return { error: '구글 AI 키(GEMINI_API_KEY)가 설정되지 않았습니다.', status: 503 };

  // 동명이인을 구분할 수 있도록, 이 작가로 저장된 레퍼런스 제목과 태그를 같이 알려줍니다.
  const { results } = await env.DB.prepare(
    'SELECT title, tags, place FROM items WHERE artist = ? ORDER BY created_at DESC LIMIT 15'
  ).bind(name).all();
  const titles = results.map((r) => r.title).filter(Boolean);
  const places = [...new Set(results.map((r) => r.place).filter(Boolean))].slice(0, 5);
  const tags = [...new Set(results.flatMap((r) => safeParse(r.tags, [])))].slice(0, 20);

  const prompt = [
    `"${name}"라는 작가(아티스트·디자이너·작가 등 창작자)를 한국어로 간단히 소개해 주세요.`,
    titles.length ? `참고: 사용자가 이 작가의 작품·전시로 저장한 것 — ${titles.join(', ')}` : '',
    places.length ? `참고: 본 곳 — ${places.join(', ')}` : '',
    tags.length ? `참고 태그: ${tags.join(', ')}` : '',
    '',
    '형식:',
    '- 첫 줄: 한 문장 요약 (어느 나라, 어떤 분야, 언제 활동)',
    '- 그다음 3~5줄: 대표 작품, 스타일·특징, 왜 레퍼런스로 볼 만한지',
    '- 마크다운 기호(#, *, **) 없이 평범한 문장으로, 한 줄에 한 문장.',
    '- 맨 마지막 줄에는 웹에서 확인한 대표작 2점을 아래 모양의 JSON 한 줄로만 적어 주세요 (줄 맨 앞은 WORKS=):',
    'WORKS=[{"title":"작품 원래 이름","titleKo":"한국어 이름","year":"제작 연도","note":"한 줄 설명","image":"작품 사진 파일의 직접 주소(https://… .jpg/.png/.webp). 확실하지 않으면 빈 문자열","page":"그 작품을 소개한 웹 페이지 주소"}]',
    '',
    '중요: 확실하지 않은 사실은 지어내지 마세요. 어떤 사람인지 찾을 수 없거나 동명이인이 여럿이라 특정할 수 없으면',
    '"정확한 정보를 찾지 못했습니다."라고 쓰고, 알 수 있는 범위만 짧게 적고, 대표작은 WORKS=[] 로 두세요.',
  ].filter((l) => l !== null).join('\n');

  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  // 구글 검색을 붙여서 먼저 시도하고, 안 되면 검색 없이, 그래도 안 되면 다른 모델로 시도합니다.
  const attempts = [
    { model, search: true },
    { model, search: false },
    ...(model !== FALLBACK_MODEL ? [{ model: FALLBACK_MODEL, search: true }, { model: FALLBACK_MODEL, search: false }] : []),
  ];
  let lastError = '';
  let lastStatus = 502;
  const skip = new Set(); // 한도·붐빔에 걸린 모델은 다시 묻지 않음
  for (const a of attempts) {
    if (skip.has(a.model)) continue;
    const res = await callGemini(env, a.model, prompt, a.search);
    if (res.text) {
      const { text, works: found } = splitWorks(res.text);
      const description = text.trim().slice(0, LIMITS.description);
      const old = await env.DB.prepare('SELECT description, by_ai, works FROM artists WHERE name = ?').bind(name).first();
      const works = [];
      for (const { imageUrl, ...w } of found.slice(0, 2)) works.push({ ...w, ...(await findWorkImage(env, name, { ...w, imageUrl })) });
      // 사장님이 직접 쓴 소개는 자동 채우기가 덮어쓰지 않습니다 (대표작만 넣음).
      const manual = keepManual && old && !old.by_ai && old.description;
      if (!manual) await upsertArtist(env, name, description, res.sources, true);
      else await env.DB.prepare('UPDATE artists SET updated_at = ? WHERE name = ?').bind(Date.now(), name).run();
      await env.DB.prepare('UPDATE artists SET works = ? WHERE name = ?').bind(JSON.stringify(works), name).run();
      await dropWorkImages(env, safeParse(old?.works, []), works);
      return { artist: manual
        ? { name, description: old.description, sources: [], byAi: false, works, model: a.model }
        : { name, description, sources: res.sources, byAi: true, works, model: a.model } };
    }
    lastError = res.error;
    lastStatus = res.status === 429 ? 429 : 502;
    if (switchModel(res)) { skip.add(a.model); continue; }
    if (stopRetry(res)) break;
  }
  return { error: `AI 설명을 만들지 못했습니다. ${lastError}`.trim(), status: lastStatus };
}

// 답의 마지막 "WORKS=[…]" 줄을 떼어 대표작 목록으로 만듭니다.
function splitWorks(text) {
  const lines = String(text).split('\n');
  let works = [];
  const keep = [];
  for (const line of lines) {
    const m = line.match(/^\s*`*\s*WORKS\s*=\s*(\[.*\])\s*`*\s*$/);
    if (!m) { if (!/^\s*```\s*(json)?\s*$/i.test(line)) keep.push(line); continue; }
    try { works = JSON.parse(m[1]); } catch { works = []; }
  }
  const cleanUrl = (u) => (/^https?:\/\/[^\s"'<>]+$/i.test(String(u || '').trim()) ? String(u).trim().slice(0, 1000) : '');
  return {
    text: keep.join('\n').trim(),
    works: (Array.isArray(works) ? works : []).filter((w) => w && (w.title || w.titleKo)).map((w) => ({
      title: str(w.title, 200), titleKo: str(w.titleKo, 200), year: str(w.year, 40), note: str(w.note, 300),
      imageUrl: cleanUrl(w.image), page: cleanUrl(w.page),
    })),
  };
}

// 대표작 그림 찾기: ① AI가 알려준 그림 주소 → ② 작품 페이지의 대표 그림(og:image) → ③ 위키미디어 공용 검색.
// 찾으면 내려받아 사진 저장소(KV)에 넣습니다 (원래 사이트에서 그림이 사라져도 보이도록).
async function findWorkImage(env, artist, w) {
  const tries = [];
  if (w.imageUrl) tries.push(() => w.imageUrl);
  if (w.page) tries.push(() => ogImageOf(w.page));
  tries.push(() => commonsImage(`${artist} ${w.title || w.titleKo}`, [artist, w.title, w.titleKo]));
  for (const t of tries) {
    try {
      const url = await t();
      if (!url) continue;
      const key = await storeRemoteImage(env, url);
      if (key) return { image: key, imageFrom: url };
    } catch { /* 다음 방법으로 */ }
  }
  return { image: '', imageFrom: '' };
}

const FETCH_HEADERS = { 'user-agent': 'zeminism-archive/1.0 (personal reference archive)', accept: 'image/*,text/html;q=0.8,*/*;q=0.5' };

async function storeRemoteImage(env, url) {
  if (!env.IMAGES || !/^https:\/\//i.test(url) || /^https:\/\/(\d+\.){3}\d+|localhost/i.test(url)) return '';
  const res = await fetch(url, { headers: FETCH_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(10000) });
  if (!res.ok) return '';
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!IMAGE_TYPES.includes(type)) return '';
  const buf = await res.arrayBuffer();
  if (buf.byteLength < 2000 || buf.byteLength > MAX_IMAGE_BYTES) return ''; // 아주 작은 건 아이콘
  const key = crypto.randomUUID();
  await env.IMAGES.put(key, buf, { metadata: { type, from: url.slice(0, 500) } });
  return key;
}

async function ogImageOf(page) {
  if (!/^https:\/\//i.test(page)) return '';
  const res = await fetch(page, { headers: FETCH_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(8000) });
  if (!res.ok || !/text\/html/i.test(res.headers.get('content-type') || '')) return '';
  const html = (await res.text()).slice(0, 300000);
  const m = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i);
  if (!m) return '';
  try { return new URL(m[1].replace(/&amp;/g, '&'), res.url || page).href; } catch { return ''; }
}

// 위키미디어 공용(자유 이용 그림 모음)에서 찾기. 파일 이름에 작가나 작품 이름이 들어간 것만 씁니다.
async function commonsImage(query, words) {
  const u = new URL('https://commons.wikimedia.org/w/api.php');
  Object.entries({
    action: 'query', format: 'json', generator: 'search', gsrnamespace: '6', gsrlimit: '5', gsrsearch: query,
    prop: 'imageinfo', iiprop: 'url|mime', iiurlwidth: '1200',
  }).forEach(([k, v]) => u.searchParams.set(k, v));
  const res = await fetch(u, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(8000) });
  if (!res.ok) return '';
  const data = await res.json();
  const norm = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const keys = words.map(norm).filter((k) => k.length >= 2);
  const pages = Object.values(data?.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  for (const p of pages) {
    const info = p.imageinfo?.[0];
    if (!info || !/image\/(jpeg|png|webp)/.test(info.mime || '')) continue;
    const name = norm(p.title);
    if (!keys.some((k) => name.includes(k))) continue;
    return info.thumburl || info.url || '';
  }
  return '';
}

// 바뀐 대표작에서 빠진 그림은 사진 저장소에서도 지웁니다.
async function dropWorkImages(env, oldWorks, newWorks) {
  const keep = new Set(newWorks.map((w) => w.image).filter(Boolean));
  await Promise.all(oldWorks.map((w) => w?.image).filter((k) => k && !keep.has(k) && /^[a-z0-9-]{8,64}$/.test(k)).map((k) => env.IMAGES?.delete(k)));
}

// 대표작 직접 고치기 (사진 바꾸기·글 고치기·빼기)
async function saveWorks(request, env, name) {
  name = String(name).trim().slice(0, LIMITS.artist);
  const body = await readJson(request);
  if (!name || !Array.isArray(body?.works)) return json({ error: '잘못된 요청입니다.' }, 400);
  const works = body.works.slice(0, 4).map((w) => ({
    title: str(w?.title, 200), titleKo: str(w?.titleKo, 200), year: str(w?.year, 40), note: str(w?.note, 300),
    image: /^[a-z0-9-]{8,64}$/.test(String(w?.image || '')) ? String(w.image) : '',
    imageFrom: str(w?.imageFrom, 1000), page: str(w?.page, 1000),
  }));
  const old = await env.DB.prepare('SELECT works FROM artists WHERE name = ?').bind(name).first();
  await env.DB.prepare(`
    INSERT INTO artists (name, works, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET works = excluded.works
  `).bind(name, JSON.stringify(works), Date.now()).run();
  await dropWorkImages(env, safeParse(old?.works, []), works);
  return json({ works });
}

/* ─────────────── 작가 자동 채우기 ─────────────── */

// 새 작가가 생기면 응답을 보낸 뒤 뒤에서 바로 소개·대표작을 찾습니다.
// 같은 작가를 여러 번 찾지 않도록 빈 줄을 먼저 넣고, 넣는 데 성공한 요청만 찾습니다.
function queueArtist(env, ctx, name) {
  if (!name || !ctx?.waitUntil || !env.GEMINI_API_KEY) return;
  ctx.waitUntil((async () => {
    const r = await env.DB.prepare("INSERT OR IGNORE INTO artists (name, description, sources, by_ai, updated_at, works) VALUES (?, '', '[]', 0, ?, '[]')")
      .bind(name, Date.now()).run();
    if (!r.meta?.changes) return; // 이미 있는 작가
    await fillArtist(env, name, true);
  })().catch((err) => console.error('auto artist', err)));
}

// 소개도 대표작도 없는 작가 한 명을 채웁니다. GitHub Actions 가 매일 여러 번 나눠 부릅니다 (무료 한도 지키기).
async function autoArtists(env) {
  const { results } = await env.DB.prepare(`
    SELECT i.artist AS name FROM items i LEFT JOIN artists a ON a.name = i.artist
    WHERE i.artist != '' AND (a.name IS NULL OR a.works IS NULL OR a.description = ''
      OR (a.works = '[]' AND a.updated_at < ?))
    GROUP BY i.artist ORDER BY MIN(COALESCE(a.updated_at, 0)) ASC, COUNT(*) DESC
  `).bind(Date.now() - 30 * 864e5).all(); // 대표작을 못 찾은 작가는 30일 뒤에 다시
  const todo = results.map((r) => r.name);
  if (!todo.length) return json({ done: null, remaining: 0 });
  if (!env.GEMINI_API_KEY) return json({ error: '구글 AI 키(GEMINI_API_KEY)가 설정되지 않았습니다.' }, 503);
  const name = todo[0];
  const r = await fillArtist(env, name, true);
  if (r.error) {
    // 실패한 작가는 맨 뒤로 (다음 번에 다른 작가부터)
    await env.DB.prepare("INSERT INTO artists (name, updated_at) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET updated_at = excluded.updated_at").bind(name, Date.now()).run();
    return json({ error: r.error, name, remaining: todo.length }, r.status || 502);
  }
  return json({ done: name, works: r.artist.works.length, images: r.artist.works.filter((w) => w.image).length, remaining: todo.length - 1 });
}

/* ─────────────── 항목 합치기 · 사진 옮기기 ─────────────── */

// 같은 관람인 여러 항목을 하나로: 사진·태그·메모를 keep 항목에 모으고 나머지 항목은 지웁니다 (사진 파일은 지우지 않음).
async function mergeItems(request, env) {
  const body = await readJson(request);
  const ids = [...new Set((Array.isArray(body?.ids) ? body.ids : []).map(String))].slice(0, 50);
  const keepId = String(body?.keep || ids[0] || '');
  if (ids.length < 2 || !ids.includes(keepId)) return json({ error: '합칠 항목을 두 개 이상 골라 주세요.' }, 400);
  const rows = [];
  for (const id of ids) {
    const r = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
    if (r) rows.push(rowToItem(r));
  }
  const keep = rows.find((r) => r.id === keepId);
  if (!keep || rows.length < 2) return notFound();
  const others = rows.filter((r) => r.id !== keepId).sort((a, b) => a.createdAt - b.createdAt);
  const images = [...new Set([...keep.images, ...others.flatMap((o) => o.images)])];
  if (images.length > MAX_IMAGES) return json({ error: `사진이 ${images.length}장이라 한 항목(최대 ${MAX_IMAGES}장)에 다 들어가지 않아요.` }, 400);
  const tags = [...new Set([...keep.tags, ...others.flatMap((o) => o.tags)])].slice(0, LIMITS.tags);
  const memo = [keep.memo, ...others.map((o) => [o.title !== keep.title ? o.title : '', o.memo].filter(Boolean).join(' — '))]
    .filter(Boolean).join('\n').slice(0, LIMITS.memo);
  const pick = (k) => keep[k] || others.find((o) => o[k])?.[k] || '';
  const visited = [keep, ...others].map((o) => o.visitedAt).filter(Boolean);
  await env.DB.batch([
    env.DB.prepare('UPDATE items SET images = ?, tags = ?, memo = ?, artist = ?, place = ?, visited_at = ?, created_at = ?, updated_at = ? WHERE id = ?')
      .bind(JSON.stringify(images), JSON.stringify(tags), memo, pick('artist'), pick('place'), visited.length ? Math.min(...visited) : 0,
        Math.min(...rows.map((r) => r.createdAt)), Date.now(), keepId),
    ...others.map((o) => env.DB.prepare('DELETE FROM items WHERE id = ?').bind(o.id)),
  ]);
  const row = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(keepId).first();
  return json({ item: rowToItem(row), removed: others.map((o) => o.id) });
}

// 사진 한 장을 다른 항목으로 옮깁니다. 원래 항목이 텅 비면(사진·제목·메모 없음) 지웁니다.
async function movePhoto(request, env, fromId) {
  const body = await readJson(request);
  const image = String(body?.image || '');
  const toId = String(body?.to || '');
  const fromRow = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(fromId).first();
  const toRow = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(toId).first();
  if (!fromRow || !toRow || fromId === toId) return notFound();
  const from = rowToItem(fromRow); const to = rowToItem(toRow);
  if (!from.images.includes(image)) return json({ error: '그 사진이 없어요.' }, 400);
  if (to.images.length >= MAX_IMAGES) return json({ error: `옮길 항목에 사진이 이미 ${MAX_IMAGES}장이에요.` }, 400);
  const fromImages = from.images.filter((k) => k !== image);
  const now = Date.now();
  const empty = !fromImages.length && !from.title && !from.memo;
  await env.DB.batch([
    env.DB.prepare('UPDATE items SET images = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify([...to.images, image]), now, toId),
    empty ? env.DB.prepare('DELETE FROM items WHERE id = ?').bind(fromId)
      : env.DB.prepare('UPDATE items SET images = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(fromImages), now, fromId),
  ]);
  const a = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(fromId).first();
  const b = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(toId).first();
  return json({ from: a ? rowToItem(a) : null, to: rowToItem(b) });
}

/* ─────────────── 백업 · 되살리기 ─────────────── */

const BACKUP_TABLES = ['items', 'artists', 'boards', 'todo_places', 'venues', 'wish', 'settings'];

// 글로 된 자료를 모두 JSON 하나로. (사진 파일은 크기 때문에 빼고, 사진 이름표만 들어감 — 사진은 Cloudflare 에 그대로 남음)
async function exportAll(env) {
  const out = { app: 'zeminism-archive', version: 1, exportedAt: new Date().toISOString(), tables: {} };
  for (const t of BACKUP_TABLES) out.tables[t] = (await env.DB.prepare(`SELECT * FROM ${t}`).all()).results;
  return new Response(JSON.stringify(out), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="reference-backup-${kstDay()}.json"`,
      'cache-control': 'no-store',
    },
  });
}

// 백업 파일로 되살리기: 같은 id 는 백업 내용으로 덮어쓰고, 없는 것은 새로 넣습니다. (지금 있는 다른 자료는 지우지 않음)
async function importAll(request, env) {
  const body = await readJson(request);
  if (body?.app !== 'zeminism-archive' || !body.tables) return json({ error: '이 앱의 백업 파일이 아니에요.' }, 400);
  const counts = {};
  for (const t of BACKUP_TABLES) {
    const rows = Array.isArray(body.tables[t]) ? body.tables[t] : [];
    if (!rows.length) continue;
    const cols = (await env.DB.prepare(`PRAGMA table_info(${t})`).all()).results.map((c) => c.name);
    const stmts = [];
    for (const r of rows) {
      const keys = Object.keys(r).filter((k) => cols.includes(k));
      if (!keys.length) continue;
      stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO ${t} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).bind(...keys.map((k) => r[k])));
    }
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    counts[t] = stmts.length;
  }
  return json({ ok: true, counts });
}

/* ─────────────── 보고 싶은 전시 ─────────────── */

// 기간 글에서 끝나는 날을 찾습니다: "2026.09.01 ~ 2026.12.31" → 2026-12-31
function endDateOf(period) {
  const all = [...String(period || '').matchAll(/(20\d\d)[.\-/년\s]+(\d{1,2})[.\-/월\s]+(\d{1,2})/g)];
  const m = all[all.length - 1];
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
}

const wishRow = (r) => ({ id: r.id, venue: r.venue, title: r.title, period: r.period, artist: r.artist, ends: r.ends, done: !!r.done, createdAt: r.created_at });

async function listWish(env) {
  const { results } = await env.DB.prepare("SELECT * FROM wish ORDER BY done, CASE WHEN ends = '' THEN '9999' ELSE ends END, created_at").all();
  return json({ wish: results.map(wishRow) });
}

async function addWish(request, env) {
  const b = await readJson(request);
  const title = String(b?.title ?? '').trim().slice(0, 200);
  if (!title) return json({ error: '전시 제목이 없어요.' }, 400);
  const venue = String(b?.venue ?? '').trim().slice(0, LIMITS.place);
  const dup = await env.DB.prepare('SELECT * FROM wish WHERE title = ? AND venue = ?').bind(title, venue).first();
  if (dup) return json({ wish: wishRow(dup), existed: true });
  const period = String(b?.period ?? '').trim().slice(0, 100);
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO wish (id, venue, title, period, artist, ends, done, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
    .bind(id, venue, title, period, String(b?.artist ?? '').trim().slice(0, 100), endDateOf(period), Date.now()).run();
  return json({ wish: wishRow(await env.DB.prepare('SELECT * FROM wish WHERE id = ?').bind(id).first()) }, 201);
}

async function updateWish(request, env, id) {
  const b = await readJson(request);
  await env.DB.prepare('UPDATE wish SET done = ? WHERE id = ?').bind(b?.done ? 1 : 0, id).run();
  const r = await env.DB.prepare('SELECT * FROM wish WHERE id = ?').bind(id).first();
  return r ? json({ wish: wishRow(r) }) : notFound();
}

async function deleteWish(env, id) {
  await env.DB.prepare('DELETE FROM wish WHERE id = ?').bind(id).run();
  return json({ ok: true });
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
    '- title: 전시면 전시 이름(전시명), 영화면 영화 제목. 알 수 없으면 무엇이 보이는지 짧은 한국어 제목. 개별 작품 이름은 memo 에',
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

  const { results } = await env.DB.prepare("SELECT artist, COUNT(*) AS n FROM items WHERE artist != '' GROUP BY artist ORDER BY n DESC").all();
  const existing = results.map((r) => r.artist);

  // 한 번 분석한 사진은 다시 묻지 않습니다 ('사진으로 채우기'로 다시 누르면 새로 물음).
  if (!body.force) {
    const c = await env.DB.prepare('SELECT result FROM analysis WHERE image = ?').bind(key).first();
    if (c) return json({ suggestion: cleanAnalysis(safeParse(c.result, {}), existing), cached: true });
  }

  // 화면에서 보낸 작은 미리보기(긴 변 768px)를 쓰면 토큰이 크게 줄어듭니다. 없으면 저장된 사진을 씁니다.
  let image;
  const thumb = String(body.thumb || '');
  if (thumb && thumb.length <= 1_500_000 && /^[A-Za-z0-9+/=]+$/.test(thumb)) image = { mimeType: 'image/jpeg', data: thumb };
  else {
    const { value, metadata } = await env.IMAGES.getWithMetadata(key, 'arrayBuffer');
    if (!value) return json({ error: '사진을 찾을 수 없습니다.' }, 404);
    image = { mimeType: metadata?.type || 'image/jpeg', data: toBase64(value) };
  }

  const parts = [{ text: analyzePrompt(existing) }, { inlineData: image }];
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
  const skip = new Set(); // 한도·붐빔에 걸린 모델은 다시 묻지 않음
  for (const a of attempts) {
    if (skip.has(a.model)) continue;
    const generationConfig = { responseMimeType: 'application/json' };
    if (a.schema) generationConfig.responseSchema = schema;
    const res = await geminiRequest(env, a.model, { contents: [{ role: 'user', parts }], generationConfig });
    if (res.text) {
      const parsed = parseJsonLoose(res.text);
      if (parsed) {
        await env.DB.prepare(`INSERT INTO analysis (image, result, created_at) VALUES (?, ?, ?)
          ON CONFLICT(image) DO UPDATE SET result = excluded.result, created_at = excluded.created_at`).bind(key, JSON.stringify(parsed), Date.now()).run().catch(() => {});
        return json({ suggestion: cleanAnalysis(parsed, existing), model: a.model });
      }
      lastError = 'AI 답을 읽지 못했습니다.';
      continue;
    }
    lastError = res.error;
    if (switchModel(res)) { skip.add(a.model); continue; }
    if (stopRetry(res)) break;
  }
  return json({ error: `사진을 분석하지 못했습니다. ${lastError}`.trim() }, 502);
}

// 여러 장을 한 번에 보여주고 "같은 관람"끼리 묶어 달라고 합니다. (작은 미리보기 사진으로 보냄)
const GROUP_MAX = 30;

function groupPrompt(existing, dates) {
  return [
    `사용자가 사진 ${dates.length}장을 한꺼번에 아이디어 아카이브에 넣으려고 합니다. 사진 번호는 첨부 순서대로 0부터입니다.`,
    dates.some(Boolean) ? `사진 찍은 날짜(모르면 빈칸): ${dates.map((d, i) => `${i}=${d || '?'}`).join(', ')}` : '',
    '',
    '같은 관람(같은 전시를 보러 가서 찍은 사진들, 같은 영화의 장면·포스터들)은 하나의 묶음으로 묶으세요.',
    '- 같은 전시장·같은 전시의 작품·포스터·안내문·공간 사진은 한 묶음입니다. 찍은 날짜가 같고 분위기·공간이 이어지면 같은 관람일 가능성이 큽니다.',
    '- 서로 다른 전시, 다른 영화, 관계없는 사진은 다른 묶음입니다. 확실하지 않으면 나누세요.',
    '',
    '각 묶음마다:',
    '- photos: 그 묶음에 들어가는 사진 번호 배열 (모든 사진이 정확히 한 묶음에만 들어가야 함)',
    '- category: "exhibition"(전시·미술관·갤러리), "movie"(영화·드라마), "etc"(그 외) 중 하나',
    '- title: 전시면 전시 이름, 영화면 영화 제목. 모르면 무엇을 본 것인지 짧은 한국어 제목',
    '- artist: 작가·감독 이름. 확실할 때만, 모르면 ""',
    '- place: 전시관·미술관 이름 (영화는 ""). 사진에 보이거나 확실할 때만, 모르면 ""',
    '- tags: 한국어 태그 2~5개',
    '- memo: 눈여겨볼 점, 알아본 작품 이름 등 한두 문장',
    '',
    existing.length ? `사용자가 이미 저장한 작가: ${existing.slice(0, 300).join(', ')}` : '',
    '이미 저장한 작가와 같은 사람이면(표기가 달라도) 목록의 이름을 그대로 쓰세요. 추측하지 마세요.',
    'JSON 하나로만 답하세요: {"groups":[...]}',
  ].filter((l) => l !== '').join('\n');
}

// AI 답을 정리: 빠진 사진은 각각 따로 묶고, 두 번 나온 사진은 처음 묶음에만 둡니다.
function cleanGroups(raw, count, existing) {
  const seen = new Set();
  const groups = [];
  for (const g of Array.isArray(raw?.groups) ? raw.groups : []) {
    const photos = (Array.isArray(g?.photos) ? g.photos : []).map(Number)
      .filter((n) => Number.isInteger(n) && n >= 0 && n < count && !seen.has(n));
    photos.forEach((n) => seen.add(n));
    if (photos.length) groups.push({ photos, ...cleanAnalysis(g, existing) });
  }
  for (let i = 0; i < count; i++) {
    if (!seen.has(i)) groups.push({ photos: [i], category: 'etc', title: '', artist: '', place: '', tags: [], memo: '' });
  }
  return groups;
}

async function groupPhotos(request, env) {
  if (!env.GEMINI_API_KEY) return json({ error: '구글 AI 키(GEMINI_API_KEY)가 설정되지 않았습니다.' }, 503);
  const body = await readJson(request);
  const photos = Array.isArray(body?.photos) ? body.photos.slice(0, GROUP_MAX) : [];
  if (!photos.length) return json({ error: '사진이 없습니다.' }, 400);
  const dates = photos.map((p) => String(p?.date || '').slice(0, 16));
  const parts = [];
  for (const p of photos) {
    const data = String(p?.data || '');
    if (!data || data.length > 1_500_000) return json({ error: '미리보기 사진이 너무 큽니다.' }, 413);
    parts.push({ inlineData: { mimeType: 'image/jpeg', data } });
  }
  const { results } = await env.DB.prepare("SELECT artist, COUNT(*) AS n FROM items WHERE artist != '' GROUP BY artist ORDER BY n DESC").all();
  const existing = results.map((r) => r.artist);
  parts.unshift({ text: groupPrompt(existing, dates) });

  const groupItem = {
    type: 'OBJECT',
    properties: {
      photos: { type: 'ARRAY', items: { type: 'INTEGER' } },
      category: { type: 'STRING', enum: CATEGORIES },
      title: { type: 'STRING' }, artist: { type: 'STRING' }, place: { type: 'STRING' },
      tags: { type: 'ARRAY', items: { type: 'STRING' } }, memo: { type: 'STRING' },
    },
    required: ['photos', 'category', 'title'],
  };
  const schema = { type: 'OBJECT', properties: { groups: { type: 'ARRAY', items: groupItem } }, required: ['groups'] };
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const attempts = [
    { model, schema: true },
    { model, schema: false },
    ...(model !== FALLBACK_MODEL ? [{ model: FALLBACK_MODEL, schema: false }] : []),
  ];
  let lastError = '';
  const skip = new Set(); // 한도·붐빔에 걸린 모델은 다시 묻지 않음
  for (const a of attempts) {
    if (skip.has(a.model)) continue;
    const generationConfig = { responseMimeType: 'application/json' };
    if (a.schema) generationConfig.responseSchema = schema;
    const res = await geminiRequest(env, a.model, { contents: [{ role: 'user', parts }], generationConfig });
    if (res.text) {
      const parsed = parseJsonLoose(res.text);
      if (parsed) return json({ groups: cleanGroups(parsed, photos.length, existing), model: a.model });
      lastError = 'AI 답을 읽지 못했습니다.';
      continue;
    }
    lastError = res.error;
    if (switchModel(res)) { skip.add(a.model); continue; }
    if (stopRetry(res)) break;
  }
  return json({ error: `사진을 묶지 못했습니다. ${lastError}`.trim() }, 502);
}

async function geminiRequest(env, model, body) {
  const r = await geminiFetch(env, model, body);
  if (r.error) return r;
  const { data, res } = r;
  const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  return text ? { text, status: res.status } : { error: '구글 AI가 빈 답을 보냈습니다.', status: res.status };
}

async function callGemini(env, model, prompt, withSearch) {
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
  if (withSearch) body.tools = [{ google_search: {} }];
  const r = await geminiFetch(env, model, body);
  if (r.error) return r;
  const { data, res } = r;
  const cand = data?.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!text) return { error: '구글 AI가 빈 답을 보냈습니다.', status: res.status };
  const sources = [];
  for (const c of cand?.groundingMetadata?.groundingChunks || []) {
    if (c.web?.uri && !sources.some((s) => s.uri === c.web.uri)) sources.push({ uri: c.web.uri, title: c.web.title || c.web.uri });
  }
  return { text: text.replace(/\*\*/g, ''), sources: sources.slice(0, 6) };
}

// 다른 방식·다른 모델로 바로 다시 묻지 말아야 할 실패: 한도(429)·구글 서버 문제(5xx)·키 문제.
// (2026-10 AI Studio 에서 503 뒤에 연달아 다시 물어 429 까지 난 것을 보고 고침)
// 구글 쪽 한도(429)·붐빔(5xx)이면 그 모델은 그만 묻고, 다음 다른 모델로 넘어갑니다. (우리가 정한 한도는 넘어가지 않음)
function switchModel(res) {
  return !res.own && (res.status === 429 || res.status >= 500);
}

function stopRetry(res) {
  return res.status === 0 || res.status === 429 || res.status >= 500 || res.status === 401 || res.status === 403 ||
    (res.status === 400 && /API key/i.test(res.error || ''));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 구글이 알려주는 "몇 초 뒤에 다시" (RetryInfo.retryDelay = "23s")
function retryDelaySec(data) {
  for (const d of data?.error?.details || []) {
    const m = String(d?.retryDelay || '').match(/^([\d.]+)s$/);
    if (m) return Math.ceil(Number(m[1]));
  }
  return 0;
}

// 우리가 정한 한도(하루 횟수·하루 토큰·분당 횟수)를 넘으면 구글에 묻기 전에 멈춥니다.
async function checkLimits(env) {
  const st = await getSettings(env);
  const lim = { req: limitOf(st, 'aiDailyRequests'), tok: limitOf(st, 'aiDailyTokens'), rpm: limitOf(st, 'aiRpm') };
  if (!lim.req && !lim.tok && !lim.rpm) return null;
  const t = await env.DB.prepare('SELECT requests, tokens FROM ai_usage WHERE day = ?').bind(kstDay()).first();
  if (lim.req && (t?.requests || 0) >= lim.req) return `오늘 AI 에너지를 다 썼어요 (하루 ${lim.req}번). 내일 다시 쓰거나 첫 화면 카드에서 한도를 바꿔 주세요.`;
  if (lim.tok && (t?.tokens || 0) >= lim.tok) return `오늘 AI 에너지를 다 썼어요 (하루 ${lim.tok.toLocaleString('ko-KR')}토큰). 내일 다시 쓰거나 첫 화면 카드에서 한도를 바꿔 주세요.`;
  if (lim.rpm) {
    const mm = await env.DB.prepare('SELECT requests FROM ai_usage WHERE day = ?').bind(minuteKey()).first();
    if ((mm?.requests || 0) >= lim.rpm) return `1분에 ${lim.rpm}번까지만 쓰도록 정해져 있어요. 1분쯤 뒤에 다시 해 주세요.`;
  }
  return null;
}

// 분당 횟수는 ai_usage 에 'm:2026-10-12T14:03' 줄로 셉니다 (하루 줄과 섞이지 않게 m: 로 시작).
function minuteKey(ms = Date.now()) {
  return `m:${new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 16)}`;
}

async function countMinute(env) {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO ai_usage (day, requests, tokens) VALUES (?, 1, 0)
      ON CONFLICT(day) DO UPDATE SET requests = requests + 1`).bind(minuteKey()),
    env.DB.prepare("DELETE FROM ai_usage WHERE day LIKE 'm:%' AND day < ?").bind(minuteKey(Date.now() - 10 * 60 * 1000)),
  ]);
}

// 구글 AI 부르기: 한도 확인 → 요청 → 503 이면 잠깐 기다렸다 최대 2번, 429 면 구글이 알려준 시간이 짧을 때만 1번 다시.
// 쓴 양은 성공한 요청만 오늘 사용량(AI 에너지)에 더합니다.
async function geminiFetch(env, model, body) {
  const blocked = await checkLimits(env).catch(() => null);
  if (blocked) return { error: blocked, status: 429, own: true };
  const waits503 = [2000, 5000];
  let waited429 = false;
  for (let attempt = 0; ; attempt++) {
    let res;
    await countMinute(env).catch(() => {});
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify(body),
      });
    } catch {
      return { error: '구글 AI에 연결하지 못했습니다.', status: 0 };
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      await recordAi(env, Number(data?.usageMetadata?.totalTokenCount) || 0).catch(() => {});
      return { data, res };
    }
    if ((res.status === 503 || res.status === 500) && attempt < waits503.length) {
      await sleep(waits503[attempt]);
      continue;
    }
    if (res.status === 429) {
      const sec = retryDelaySec(data);
      if (!waited429 && sec > 0 && sec <= 8) { waited429 = true; await sleep(sec * 1000); continue; }
      return { error: `구글 AI 무료 한도에 걸렸어요.${sec ? ` ${sec}초쯤 뒤에` : ' 잠시 뒤에'} 다시 해 주세요.`, status: 429 };
    }
    if (res.status >= 500) return { error: '구글 AI 서버가 지금 붐벼요. 잠시 뒤에 다시 해 주세요.', status: res.status };
    return { error: data?.error?.message || `HTTP ${res.status}`, status: res.status };
  }
}

/* ─────────────── 가볼 곳 (퀘스트) ─────────────── */

// 2026-10-12 사장님이 사진으로 준 목록. 처음 한 번만 넣고, 그 뒤로는 화면에서 더하고 뺍니다.
// keys: 레퍼런스의 전시관 이름에 이 글자가 들어 있으면 '다녀옴'으로 칩니다.
const TODO_SEED = [
  ['3호선 안국역 근처', '금호미술관', ['금호미술관']],
  ['3호선 안국역 근처', '갤러리현대', ['갤러리현대', '현대갤러리']],
  ['3호선 안국역 근처', '학고재', ['학고재']],
  ['3호선 안국역 근처', '국제갤러리', ['국제갤러리']],
  ['3호선 안국역 근처', '아트선재센터', ['아트선재']],
  ['3호선 안국역 근처', 'PKM갤러리', ['pkm']],
  ['서울', '일민미술관', ['일민']],
  ['서울', '리움미술관', ['리움']],
  ['서울', '송은', ['송은']],
  ['서울', '아모레퍼시픽미술관', ['아모레퍼시픽']],
  ['서울', '성곡미술관', ['성곡']],
  ['평창동', '가나아트센터', ['가나아트']],
  ['평창동', '토탈미술관', ['토탈미술관']],
  ['평창동', '김종영미술관', ['김종영']],
  ['경기·강원', '국립현대미술관 과천', ['국립현대미술관과천', '과천국립현대미술관', 'mmca과천']],
  ['경기·강원', '백남준아트센터 (용인)', ['백남준아트센터']],
  ['경기·강원', '뮤지엄 산 (원주)', ['뮤지엄산', 'museumsan']],
];

function todoRow(r) {
  return { id: r.id, name: r.name, area: r.area, keys: safeParse(r.keys, []), done: !!r.done, sort: r.sort, createdAt: r.created_at };
}

async function listTodo(env) {
  const st = await getSettings(env);
  if (!st.todoSeeded) {
    const now = Date.now();
    await env.DB.batch([
      ...TODO_SEED.map(([area, name, keys], i) => env.DB.prepare('INSERT INTO todo_places (id, name, area, keys, done, sort, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
        .bind(crypto.randomUUID(), name, area, JSON.stringify(keys), i, now)),
      env.DB.prepare("INSERT INTO settings (key, value) VALUES ('todoSeeded', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"),
    ]);
  }
  const { results } = await env.DB.prepare('SELECT * FROM todo_places ORDER BY sort, created_at').all();
  return json({ todo: results.map(todoRow) });
}

async function addTodo(request, env) {
  const body = await readJson(request);
  const name = String(body?.name ?? '').trim().slice(0, LIMITS.place);
  const area = String(body?.area ?? '').trim().slice(0, 40);
  if (!name) return json({ error: '장소 이름을 적어 주세요.' }, 400);
  const id = crypto.randomUUID();
  const max = await env.DB.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM todo_places').first();
  await env.DB.prepare('INSERT INTO todo_places (id, name, area, keys, done, sort, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
    .bind(id, name, area, JSON.stringify([name]), (max?.m || 0) + 1, Date.now()).run();
  const r = await env.DB.prepare('SELECT * FROM todo_places WHERE id = ?').bind(id).first();
  return json({ place: todoRow(r) }, 201);
}

async function updateTodo(request, env, id) {
  const body = await readJson(request);
  await env.DB.prepare('UPDATE todo_places SET done = ? WHERE id = ?').bind(body?.done ? 1 : 0, id).run();
  const r = await env.DB.prepare('SELECT * FROM todo_places WHERE id = ?').bind(id).first();
  return r ? json({ place: todoRow(r) }) : notFound();
}

async function deleteTodo(env, id) {
  await env.DB.prepare('DELETE FROM todo_places WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

/* ─────────────── 전시관 정보 (팝업) ─────────────── */

const VENUE_FIELDS = ['name', 'address', 'hours', 'closed', 'admission', 'phone', 'website', 'notes'];

function cleanVenue(o) {
  const out = {};
  for (const k of VENUE_FIELDS) out[k] = String(o?.[k] ?? '').trim().slice(0, k === 'notes' ? 600 : 300);
  const lat = Number(o?.lat); const lng = Number(o?.lng);
  // 한국 근처 좌표만 받습니다 (코스 짜기용 대략 위치)
  if (lat > 32 && lat < 39.5 && lng > 124 && lng < 132) { out.lat = lat; out.lng = lng; }
  out.exhibitions = (Array.isArray(o?.exhibitions) ? o.exhibitions : []).slice(0, 8).map((e) => ({
    title: String(e?.title || '').trim().slice(0, 200),
    period: String(e?.period || '').trim().slice(0, 100),
    artist: String(e?.artist || '').trim().slice(0, 100),
    desc: String(e?.desc || '').trim().slice(0, 300),
  })).filter((e) => e.title);
  return out;
}

async function getVenue(env, name) {
  name = String(name).trim().slice(0, LIMITS.place);
  const r = await env.DB.prepare('SELECT * FROM venues WHERE name = ?').bind(name).first();
  if (!r) return json({ venue: null });
  return json({ venue: { name, info: safeParse(r.info, {}), sources: safeParse(r.sources, []), updatedAt: r.updated_at } });
}

async function refreshVenue(env, name) {
  name = String(name).trim().slice(0, LIMITS.place);
  if (!name) return json({ error: '전시관 이름이 없습니다.' }, 400);
  if (!env.GEMINI_API_KEY) return json({ error: '구글 AI 키(GEMINI_API_KEY)가 설정되지 않았습니다.' }, 503);
  const today = kstDay();
  const prompt = [
    `"${name}" (전시관·미술관·갤러리, 한국일 가능성이 큼)의 정보를 구글 검색으로 확인해서 아래 JSON 하나로만 답하세요. 오늘은 ${today} 입니다.`,
    '{',
    '  "name": "정식 이름",',
    '  "address": "도로명 주소",',
    '  "hours": "운영시간 (요일마다 다르면 줄바꿈으로 나눠서, 예: 화~일 10:00~18:00\\n수·토 10:00~21:00)",',
    '  "closed": "휴관일 (예: 매주 월요일, 1월 1일, 설·추석 당일)",',
    '  "admission": "관람료 (전시마다 다르면 그렇다고)",',
    '  "phone": "대표 전화",',
    '  "website": "공식 홈페이지 주소",',
    `  "exhibitions": [{"title":"전시 제목","period":"기간 (예: 2026.09.01 ~ 2026.12.31)","artist":"작가","desc":"한 줄 소개"}]  ← ${today} 기준 지금 하고 있거나 곧 시작하는 전시만`,
    '  "notes": "알아두면 좋은 점 (예약 필요, 주차 등) 한두 문장",',
    '  "lat": 위도 숫자, "lng": 경도 숫자  ← 주소 기준 대략적인 위치 (코스 짜기에 씀)',
    '}',
    '중요: 검색으로 확인한 내용만 쓰세요. 확인하지 못한 값은 빈 문자열 "" 로 두고, 지어내지 마세요. 끝난 전시는 넣지 마세요.',
  ].join('\n');
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const attempts = [model, ...(model !== FALLBACK_MODEL ? [FALLBACK_MODEL] : [])];
  let lastError = '';
  const skip = new Set();
  for (const mdl of attempts) {
    if (skip.has(mdl)) continue;
    // 구글 검색 도구와 JSON 모양 지정은 같이 쓸 수 없어서, 글로 받은 뒤 JSON 부분만 읽습니다.
    const res = await callGemini(env, mdl, prompt, true);
    if (res.text) {
      const parsed = parseJsonLoose(res.text);
      if (!parsed) { lastError = 'AI 답을 읽지 못했습니다.'; continue; }
      const info = cleanVenue(parsed);
      const now = Date.now();
      await env.DB.prepare(`INSERT INTO venues (name, info, sources, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET info = excluded.info, sources = excluded.sources, updated_at = excluded.updated_at`)
        .bind(name, JSON.stringify(info), JSON.stringify(res.sources || []), now).run();
      return json({ venue: { name, info, sources: res.sources || [], updatedAt: now } });
    }
    lastError = res.error;
    if (switchModel(res)) { skip.add(mdl); continue; }
    if (stopRetry(res)) break;
  }
  return json({ error: `전시관 정보를 찾지 못했습니다. ${lastError}`.trim() }, 502);
}

/* ─────────────── AI 사용량 · 설정 (첫 화면 게임 카드) ─────────────── */

// 하루는 한국 시간 기준으로 나눕니다.
function kstDay(ms = Date.now()) {
  return new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

async function recordAi(env, tokens) {
  await env.DB.prepare(`INSERT INTO ai_usage (day, requests, tokens) VALUES (?, 1, ?)
    ON CONFLICT(day) DO UPDATE SET requests = requests + 1, tokens = tokens + excluded.tokens`).bind(kstDay(), tokens).run();
}

// 사장님이 정한 값이 있으면 그것(0 = 안 정함), 없으면 기본 한도
function limitOf(st, k) {
  return k in st ? Number(st[k]) || 0 : DEFAULT_LIMITS[k] || 0;
}

async function getSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

async function getStats(env) {
  const today = kstDay();
  const month = today.slice(0, 7);
  const t = await env.DB.prepare('SELECT requests, tokens FROM ai_usage WHERE day = ?').bind(today).first();
  const mo = await env.DB.prepare('SELECT COALESCE(SUM(requests),0) AS requests, COALESCE(SUM(tokens),0) AS tokens FROM ai_usage WHERE day LIKE ?').bind(`${month}%`).first();
  const st = await getSettings(env);
  return json({
    ai: {
      provider: 'gemini',
      configured: !!env.GEMINI_API_KEY,
      day: today,
      today: { requests: t?.requests || 0, tokens: t?.tokens || 0 },
      month: { requests: mo?.requests || 0, tokens: mo?.tokens || 0 },
      limit: { tokens: limitOf(st, 'aiDailyTokens'), requests: limitOf(st, 'aiDailyRequests'), rpm: limitOf(st, 'aiRpm') },
    },
    water: waterOf(st, today),
  });
}

/* ─────────────── 화분 물 주기 (첫 화면 다마고치) ─────────────── */

// 날짜는 한국 시간 기준. 어제도 줬으면 연속 일수 +1, 하루 건너뛰면 1부터.
function waterOf(st, today) {
  const last = st.waterLast || '';
  let streak = Number(st.waterStreak) || 0;
  if (last && last !== today && last !== dayBefore(today)) streak = 0; // 끊긴 연속 기록
  return { today, last, streak, total: Number(st.waterTotal) || 0, watered: last === today };
}

function dayBefore(day) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function waterPlant(env) {
  const today = kstDay();
  const st = await getSettings(env);
  const w = waterOf(st, today);
  if (w.watered) return json({ water: w, already: true });
  const next = { waterLast: today, waterStreak: String(w.streak + 1), waterTotal: String(w.total + 1) };
  await env.DB.batch(Object.entries(next).map(([k, v]) =>
    env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(k, v)));
  return json({ water: waterOf({ ...st, ...next }, today), already: false });
}

async function saveSettings(request, env) {
  const body = await readJson(request);
  if (!body) return json({ error: '잘못된 요청입니다.' }, 400);
  const num = (v) => Math.max(0, Math.min(1e10, Math.floor(Number(v) || 0)));
  const stmts = [];
  for (const k of ['aiDailyTokens', 'aiDailyRequests', 'aiRpm']) {
    if (k in body) stmts.push(env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(k, String(num(body[k]))));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return getStats(env);
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
