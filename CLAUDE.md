# 레퍼런스(아이디어 아카이브) — 작업 규칙

## 답하는 방식
- 한국어로, 쉬운 말로 답합니다.
- 모르면 모른다고 말합니다. 확인하지 못한 것은 확인하지 못했다고 적습니다.
- 답의 끝에 "물어보면 좋은 질문 3가지"를 붙입니다.
- 작업을 마무리할 때는 맨 마지막에 실제 사이트 주소를 적습니다.
  - 사이트: https://zeminism-archive.pages.dev
  - 관리(작업 계획): https://zeminism-archive.pages.dev/admin
  - 지금 쓰는 판(Claude 아티팩트): https://claude.ai/artifact/WTetfftZg4dor2pEFnf2Zs — `app/` 고친 뒤 `python3 artifact/build.py` 로 다시 만들고 같은 파일 경로로 올림

## 디자인
- 토스 느낌: 흰 바탕, 회색 면(#F2F4F6), 파란 단추(#3182F6), 글자 #191F28, 큰 둥근 모서리, Pretendard 글꼴.
- 휴대폰 먼저. 아래 탭 + 오른쪽 아래 + 단추 + 바텀시트.

## 구조
- `app/` 이 그대로 Cloudflare Pages 에 올라갑니다. 빌드 과정 없음.
- 서버는 `app/_worker.js` 한 파일 (D1 = DB, KV = IMAGES, 비밀값 ADMIN_PASSWORD · GEMINI_API_KEY).
- 2026-10-12 사장님 요청: "일단은 비밀번호 없이" 배포. ADMIN_PASSWORD 가 없으면 누구나 수정 가능(열린 모드), 넣으면 잠김.
- 분류 키맵(2026-10-12 사장님 요청): 전시관 → 영화 → 그 외 순서 고정. 값은 exhibition / movie / etc, 예전 자료는 etc.
- 전시 방문 횟수(레벨·가볼 곳·전시관 팝업): 같은 전시관 + 같은 날 올린 항목은 1번. 전시관 이름 없는 항목은 그날 전시관에 붙임 (2026-10-12 사장님: 실제 3번인데 12번으로 나와서 고침).
- 가볼 곳 목록은 사장님이 사진으로 준 17곳 (`_worker.js` TODO_SEED, 처음 한 번만 넣음).
- 표는 `_worker.js` 의 ensureSchema 가 자동으로 만듭니다. 칸을 추가할 때는 ALTER 를 따로 넣어야 합니다.

## 배포
- 자동 아님. GitHub Actions → "사이트 배포 (레퍼런스)" → Run workflow.
- 이사·청소 사이트(zeminismharu/8285-html)와 같은 Cloudflare 계정, 같은 방식.

## 조심할 것
- 바텀시트를 닫고 바로 화면을 옮길 때는 `await closeSheet()` 를 먼저 (뒤로가기 기록이 꼬임).
- `.onclick = closeSheet` 처럼 함수를 그대로 넘기지 않기 (이벤트가 인자로 들어가 동작이 바뀜).
- 전역 `svg {}` 아이콘 규칙이 계획 보드 도화지에 번지지 않도록 `#board` 에 기본값을 따로 줍니다.
