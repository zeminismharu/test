# 레퍼런스 — 아이디어 아카이브

사진과 메모로 아이디어를 모으고, 작가별로 정리하고, 언제든 검색해서 찾는 웹앱입니다.
관리 화면에서는 조명 위치·색온도(K)·앞으로 할 일을 직접 그려서 계획합니다.

- **지금 쓰는 주소 (Claude 아티팩트)**: https://claude.ai/artifact/WTetfftZg4dor2pEFnf2Zs
  - 오른쪽 위 "계획" 키 → 작업 계획 보드
- Cloudflare 주소 (비밀값을 넣고 배포하면 열림): https://zeminism-archive.pages.dev

## Claude 아티팩트 판 (`artifact/`)

Cloudflare 비밀값 없이 바로 쓰려고 만든 판입니다. 화면은 `app/` 과 같고, 저장만 다릅니다.
- 글·작가 소개·계획 보드 → Claude 저장소(db), 사진 → Claude 사진 저장소(assets)
- 작가 소개 AI → 구글 Gemini 대신 **Claude**. 인터넷 검색은 못 하고, 출처 링크도 없습니다.
- 사진 기능을 쓰는 아티팩트는 **공개 링크로 공유할 수 없습니다** (Share 메뉴에서 사람을 초대해야 함).
- `app/` 을 고친 뒤 `python3 artifact/build.py` → `artifact/reference.html` 을 다시 올리면 같은 주소가 갱신됩니다.

## 할 수 있는 것

**메인 화면 (누구나 볼 수 있음)**
- **첫 화면 게임 카드**: 전시 다녀온 횟수로 레벨(Lv.)과 칭호, 다음 레벨까지 막대. **AI 에너지** 막대 = 하루 한도 - 오늘 쓴 양 (구글은 남은 양을 알려주지 않아 앱이 직접 셈, 한도는 카드를 눌러 정함)
- **분류 키맵**: 맨 위 `전체 · 전시관 · 영화 · 그 외` 단추 (키보드 `0` `1` `2` `3`). 레퍼런스마다 셋 중 하나를 고름
- 사진(여러 장) + 제목 + 작가 + 메모 + 태그 + 출처로 레퍼런스 저장
- **사진 자동 분류**: 사진을 넣으면 AI(Gemini, Claude 판은 Claude)가 분류·제목·작가·전시관 이름·태그·메모를 채움. 이미 적은 칸은 건드리지 않음
- **여러 장 한꺼번에**: + → "사진 여러 장 한꺼번에". AI가 사진을 함께 보고 **같은 관람(같은 전시·같은 영화)끼리 한 항목으로 묶음**. 찍은 날짜(EXIF)도 참고. 같은 관람 항목이 이미 있으면 거기에 사진을 더함. AI가 안 되면 찍은 날짜끼리 묶음
- 항목 제목은 전시 이름 또는 영화 제목 (개별 작품 이름은 메모에)
- **같은 작가 합치기**: 띄어쓰기·대소문자만 다른 이름(제임스터렐 / 제임스 터렐)은 이미 있는 이름으로 맞춤. AI는 영어·한국어 표기가 달라도 기존 이름을 쓰도록 안내받음
- **전시관 정보 팝업**: 전시관 이름(상세 화면, 전시관 탭의 '다녀온 전시관' 단추)을 누르면 주소·지도(네이버/구글)·운영시간·휴관일·관람료·지금 하는 전시. Gemini 가 구글 검색으로 찾아 정리하고 출처 표시, 7일마다 새로 찾음 (Claude 판은 검색 없이 알고 있는 정보만)
- **전시관 이름 · 작성일**: 카드와 상세 화면에 표시 (영화는 "본 곳", 그 외는 "장소")
- 검색: 제목·작가·메모·태그·출처를 한 번에. 초성 검색도 됨 (`ㄱㅎ` → 고흐)
- 필터: 태그(여러 개 동시), 작가, 정렬(최신·오래된·제목·작가), 사진/목록 보기
- 작가별 탭: 작가마다 모아 보기 + **구글 Gemini AI 작가 소개** (구글 검색으로 확인하고 출처 링크도 같이 보여줌)
- 작가 소개는 직접 써도 됩니다

**관리 화면 `/admin`**
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
| `CLOUDFLARE_API_TOKEN` | 이 앱 전용으로 새로 만든 토큰 (아래 "전용 토큰 만들기") |
| `CLOUDFLARE_ACCOUNT_ID` | 이사 사이트와 같은 계정 ID |
| `ADMIN_PASSWORD` | (선택) 잠글 때만. 안 넣으면 열린 모드 |
| `GEMINI_API_KEY` | https://aistudio.google.com/apikey 에서 만든 키 |

### 전용 토큰 만들기 (이사 사이트 토큰과 따로)

이 앱 토큰이 새어 나가도 이사·청소 사이트는 안전하도록 따로 만듭니다.

1. https://dash.cloudflare.com/profile/api-tokens 접속 → **Create Token**
2. 맨 아래 **Custom token → Get started**
3. Token name: `zeminism-archive 배포`
4. Permissions 에 3줄 (왼쪽부터 Account → 항목 → Edit)
   - `Account` · `Cloudflare Pages` · `Edit`
   - `Account` · `D1` · `Edit`
   - `Account` · `Workers KV Storage` · `Edit`
5. Account Resources: `Include` · 이사 사이트가 있는 그 계정
6. **Continue to summary → Create Token** → 나온 토큰을 복사 (이 화면을 닫으면 다시 볼 수 없음)
7. 계정 ID: Cloudflare 첫 화면 → **Workers & Pages** → 오른쪽에 있는 **Account ID** 복사

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
