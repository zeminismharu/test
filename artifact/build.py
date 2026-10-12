#!/usr/bin/env python3
"""app/ 의 화면 코드를 Claude 아티팩트 한 장(reference.html)으로 합칩니다.

서버(_worker.js) 대신 artifact/adapter.js 가 Claude 저장소를 씁니다.
app/ 을 고친 뒤 이 스크립트를 다시 돌리면 아티팩트도 같은 내용으로 맞춰집니다.

    python3 artifact/build.py
"""
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
APP = ROOT / 'app'
OUT = ROOT / 'artifact' / 'reference.html'


def read(p):
    return (APP / p).read_text(encoding='utf-8')


def sub(text, old, new, count=1):
    n = text.count(old)
    if n != count:
        raise SystemExit(f'바꿀 곳을 찾지 못함 ({n}/{count}): {old[:70]!r}')
    return text.replace(old, new)


def body_of(html):
    return html[html.index('<body'):].split('>', 1)[1].rsplit('</body>', 1)[0]


def strip_module(js):
    js = re.sub(r"^import .*?;\n", '', js, flags=re.M)
    return re.sub(r'^export ', '', js, flags=re.M)


# ── CSS: 다크 모드를 아티팩트 규칙(data-theme)에 맞추기 ──
css = read('style.css') + '\n' + read('admin.css')
dark_start = css.index('@media (prefers-color-scheme: dark) {\n  :root {')
dark_end = css.index('\n}\n', dark_start) + 3
dark_block = css[dark_start:dark_end]
tokens = dark_block.split(':root {', 1)[1].rsplit('}', 2)[0] + '    --danger-bg: #3a1f23;\n  '
css = css[:dark_start] + (
    '@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {' + tokens + '} }\n'
    ':root[data-theme="dark"] {' + tokens + '}\n'
) + css[dark_end:]
css = sub(css, '  --red: #f04452;\n', '  --red: #f04452;\n  --danger-bg: #ffeeee;\n')
css = sub(css, '.btn.danger { background: #ffeeee; color: var(--red); }', '.btn.danger { background: var(--danger-bg); color: var(--red); }')
css = sub(css, '@media (prefers-color-scheme: dark) { .btn.danger { background: #3a1f23; } }\n', '')
# 상단바: 화면 위 안전 영역은 페이지 바깥(:root)이 이미 띄워 주므로 sticky 위치만 맞춥니다.
css = sub(css, '  position: sticky; top: 0; z-index: 20;', '  position: sticky; top: env(safe-area-inset-top, 0px); z-index: 20;')
css = sub(css, '  padding-top: env(safe-area-inset-top);\n', '')
css = css.replace("font-family: 'Pretendard Variable', Pretendard, -apple-system",
                  "font-family: 'Pretendard Variable', Pretendard, 'Noto Sans KR', -apple-system")
css += '\n.admin-back { display: inline-flex; align-items: center; gap: 2px; color: var(--text-2); font-weight: 600; font-size: 15px; }\n.admin-back svg { width: 20px; height: 20px; }\n'

# ── HTML ──
main_body = body_of(read('index.html'))
main_body = main_body[:main_body.index('  <!-- 바텀시트')]  # 시트·토스트는 아래에서 한 번만
admin_body = body_of(read('admin.html'))
admin_body = admin_body[:admin_body.index('  <input type="file" id="bgInput"')]
admin_body = sub(admin_body, '<a class="back-link" href="/"><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>레퍼런스</a>',
                 '<button class="admin-back" id="adminBackBtn" type="button"><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>레퍼런스</button>')
shared_tail = '''
  <input type="file" id="bgInput" accept="image/*" hidden />
  <div class="sheet-backdrop" id="backdrop" hidden></div>
  <div class="sheet" id="sheet" role="dialog" aria-modal="true" hidden>
    <div class="sheet-handle"></div>
    <div class="sheet-body" id="sheetBody"></div>
  </div>
  <div class="viewer" id="viewer" hidden>
    <button class="viewer-close" id="viewerClose" type="button" aria-label="닫기"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    <img id="viewerImg" alt="" />
  </div>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>
'''

# ── JS ──
common = strip_module(read('common.js'))
# 아티팩트 화면 안에서는 브라우저 "뒤로" 기록을 쓰지 않습니다 (시트는 닫기 단추·바깥 누르기·Esc 로 닫힘).
common = sub(common, "  if (!sheetOpen) history.pushState({ sheet: true }, '');\n", '')
common = sub(common, "  if (!fromPop && history.state?.sheet) {", "  if (false) {")
# 서버 대신 adapter 의 api 를 씁니다.
start = common.index('export async function api') if 'export async function api' in common else common.index('async function api')
end = common.index('\nlet toastTimer')
common = common[:start] + common[end:]

app = strip_module(read('app.js'))
app = app.replace('/img/${', '/_blob/${')
app = sub(app, "  const h = decodeURIComponent(location.hash.replace(/^#\\/?/, ''));", "  const h = navHash.replace(/^#\\/?/, '');")
app = sub(app, "  if (location.hash !== hash) location.hash = hash;\n  else route();", "  navHash = decodeURIComponent(hash);\n  route();")
app = sub(app, "window.addEventListener('hashchange', route);\n", "let navHash = '#/';\n")
app = sub(app, "$('#adminBtn').onclick = () => (location.href = '/admin');", "$('#adminBtn').onclick = () => showScreen('admin');")
app = sub(app, "location.href = '/admin';", "showScreen('admin');")
app = sub(app, '누르면 구글 AI가 이 작가를', '누르면 AI가 이 작가를')
app = sub(app, "'구글 AI가 작가를 찾아보고 있어요… (10초쯤 걸려요)'", "'AI가 작가 소개를 쓰고 있어요… (10초쯤 걸려요)'")
app = sub(app, "'AI 설명은 틀릴 수 있어요. 중요한 내용은 출처에서 꼭 확인하세요.'", "'AI 설명은 틀릴 수 있어요. 중요한 내용은 꼭 따로 확인하세요.'")
# 관리 화면 키는 관리 화면이 보일 때 눌리지 않도록
app = sub(app, "    if (e.target.closest('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;",
          "    if ($('#mainScreen').hidden) return;\n    if (e.target.closest('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;")

admin = strip_module(read('admin.js'))
admin = admin.replace('/img/${', '/_blob/${')
# PNG 저장: 아티팩트에서는 <a download> 가 막혀 있어서 downloads 기능으로 저장합니다.
admin = sub(admin, "    const a = document.createElement('a');\n", "")
admin = sub(admin, "    a.download = `${($('#edTitle').value || '계획').replace(/[\\\\/:*?\"<>|]/g, '')}.png`;\n    a.href = canvas.toDataURL('image/png');\n    a.click();",
                "    const filename = `${($('#edTitle').value || '계획').replace(/[\\\\/:*?\"<>|]/g, '')}.png`;\n    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));\n    const downloads = await window.claude?.use?.('downloads');\n    if (!downloads) { toast('이 화면에서는 파일로 저장할 수 없어요'); return; }\n    await downloads.save({ filename, data: blob }).catch(() => toast('저장을 취소했어요'));")
admin = sub(admin, "  const id = location.hash.replace(/^#\\/?/, '');", "  const id = adminBoardId;")
admin = sub(admin, "    location.hash = board.id;", "    adminGo(board.id);")
admin = sub(admin, "    location.hash = '';\n    return;", "    adminGo('');\n    return;")
admin = sub(admin, "  $('#edBack').onclick = () => { location.hash = ''; };", "  $('#edBack').onclick = () => adminGo('');")
admin = sub(admin, "      location.hash = '';\n      toast('지웠어요');", "      adminGo('');\n      toast('지웠어요');")
admin = sub(admin, "  window.addEventListener('hashchange', route);\n", "  $('#adminBackBtn').onclick = async () => { await flushSave(); showScreen('main'); };\n  onAdminShow = () => route();\n")
admin = sub(admin, '\n/* ─────────────── 보드 목록', "\nlet adminBoardId = '';\nfunction adminGo(id) { adminBoardId = id; route(); }\n\n/* ─────────────── 보드 목록")
admin = admin.replace("$('#listScreen').hidden = true;", "$('#listScreen').hidden = true;")
# 창을 닫을 때 keepalive 로 서버에 보내던 부분은 아티팩트에서는 쓸 수 없어 마지막 저장만 시도합니다.
bu_start = admin.index("window.addEventListener('beforeunload'")
bu_end = admin.index('\n});\n\n/* ─────────────── 되돌리기', bu_start) + 5
admin = admin[:bu_start] + "window.addEventListener('pagehide', () => { if (ed.dirty) save(); });\n" + admin[bu_end:]

adapter = strip_module((ROOT / 'artifact' / 'adapter.js').read_text(encoding='utf-8'))

script = f'''
// ===== 저장소 연결 (adapter.js) =====
{adapter}
// ===== 공용 (common.js) =====
{common}
// ===== 화면 전환 =====
let onAdminShow = null;
function showScreen(name) {{
  $('#mainScreen').hidden = name !== 'main';
  $('#adminScreen').hidden = name !== 'admin';
  document.body.classList.toggle('admin', name === 'admin');
  window.scrollTo({{ top: 0 }});
  if (name === 'admin' && onAdminShow) onAdminShow();
  if (name === 'main') {{ document.body.classList.remove('editing'); refreshMain && refreshMain(); }}
}}
let refreshMain = null;
// ===== 관리 화면 (admin.js) =====
{{
{admin}
}}
// ===== 메인 화면 (app.js) =====
{{
{app}
refreshMain = () => loadAll();
}}
'''

# 관리 화면의 init() 는 화면을 열 때가 아니라 처음에 한 번 묶어 두고, 목록은 열 때 불러옵니다.
script = sub(script, "async function init() {\n  const s = await api('/api/session').catch(() => ({}));\n  if (s.loggedIn) showBoards();\n  else showLogin();",
             "async function init() {\n  const s = await api('/api/session').catch(() => ({}));\n  if (s.loggedIn) { $('#loginBox').hidden = true; $('#boardsBox').hidden = false; }\n  else showLogin();")

page = f'''<title>레퍼런스</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;600;700;800&display=swap">
<style>
{css}
</style>
<div id="mainScreen">
{main_body}
</div>
<div id="adminScreen" hidden>
{admin_body}
</div>
{shared_tail}
<script type="module">
{script}
</script>
'''
OUT.write_text(page, encoding='utf-8')
print(f'만듦: {OUT.relative_to(ROOT)} ({len(page.encode()) // 1024} KB)')
