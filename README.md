# 레퍼런스 — 아이디어 아카이브

사진과 메모로 아이디어를 모으고, 작가별로 정리하고, 언제든 검색해서 찾는 웹앱입니다.
관리 화면에서는 조명 위치·색온도(K)·앞으로 할 일을 직접 그려서 계획합니다.

- 사이트: https://zeminism-archive.pages.dev
- 관리(작업 계획): https://zeminism-archive.pages.dev/admin

## 할 수 있는 것

**메인 화면 (누구나 볼 수 있음)**
- 사진(여러 장) + 제목 + 작가 + 메모 + 태그 + 출처로 레퍼런스 저장
- 검색: 제목·작가·메모·태그·출처를 한 번에. 초성 검색도 됨 (`ㄱㅎ` → 고흐)
- 필터: 태그(여러 개 동시), 작가, 정렬(최신·오래된·제목·작가), 사진/목록 보기
- 작가별 탭: 작가마다 모아 보기 + **구글 Gemini AI 작가 소개** (구글 검색으로 확인하고 출처 링크도 같이 보여줌)
- 작가 소개는 직접 써도 됩니다

**관리 화면 `/admin` (비밀번호 필요)**
- 메인 화면 오른쪽 위 검은 **"계획" 키**, 또는 키보드 `\` (₩) 키로 이동
- 도화지에 펜으로 그리기, 지우개, 글자
- 조명 놓기: 종류(다운라이트·스포트·펜던트·라인·간접), **색온도 1800~10000K**, 밝기, 빛 퍼짐, 방향, 길이, 메모
- 도면이나 현장 사진을 배경으로 깔고 그 위에 그리기
- 앞으로 할 일(날짜, 체크), 계획 메모
- 되돌리기/다시, 두 손가락 확대·이동, PNG로 저장, 자동 저장

**지금은 비밀번호 없이 누구나 추가·수정·삭제할 수 있는 '열린 모드'입니다.**
나중에 잠그려면 `ADMIN_PASSWORD` 비밀값을 넣고 다시 배포하면 됩니다. 그때부터 추가·수정·삭제·AI 설명·관리 화면은 로그인한 뒤에만 됩니다.

## 처음 한 번 (배포 준비)

배포는 이사청소 사이트와 같은 방식입니다 (GitHub Actions → Cloudflare Pages).
비밀값은 저장소마다 따로라서, 이 저장소에 한 번 넣어 주셔야 합니다.

1. GitHub 이 저장소 → **Settings → Secrets and variables → Actions → New repository secret**
2. 아래 4개를 넣기

| 이름 | 값 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 이사 사이트(8285-html)에 넣은 것과 같은 토큰 |
| `CLOUDFLARE_ACCOUNT_ID` | 이사 사이트와 같은 계정 ID |
| `ADMIN_PASSWORD` | (선택) 잠글 때만. 안 넣으면 열린 모드 |
| `GEMINI_API_KEY` | https://aistudio.google.com/apikey 에서 만든 키 |

3. **토큰 권한 확인**: Cloudflare → My Profile → API Tokens 에서 그 토큰에
   `Cloudflare Pages: Edit`, `D1: Edit`, `Workers KV Storage: Edit` 가 있어야 합니다.
   (이사 사이트 토큰에 Pages 만 있다면 D1·KV 두 개를 추가해 주세요.)

## 배포하기

GitHub → **Actions** → 왼쪽 **"사이트 배포 (레퍼런스)"** → **Run workflow**

처음 실행할 때 Cloudflare 프로젝트, 데이터베이스(D1), 사진 저장소(KV)를 자동으로 만들고 연결합니다.

## 구조

```
app/
  index.html  app.js      메인 화면 (검색·필터·작가별·추가/수정)
  admin.html  admin.js    관리 화면 (작업 계획 보드)
  common.js               같이 쓰는 도우미 (API, 사진 줄이기, 바텀시트)
  style.css   admin.css   토스 느낌 디자인
  _worker.js              서버 (API · 로그인 · 사진 · 구글 AI)
.github/workflows/deploy.yml   배포
```

- 데이터: Cloudflare D1 (`items`, `artists`, `boards` 표 — 처음 요청 때 자동 생성)
- 사진: Cloudflare KV (올리기 전에 긴 변 2000px 로 줄임)
- AI: Google Gemini API (기본 모델 `gemini-3.6-flash`, 저장소 Variables 에 `GEMINI_MODEL` 로 바꿀 수 있음)

## 내 컴퓨터에서 돌려보기

```bash
npx wrangler@4 pages dev app --d1 DB --kv IMAGES --binding ADMIN_PASSWORD=test1234
# AI 까지 보려면: --binding GEMINI_API_KEY=키
```
