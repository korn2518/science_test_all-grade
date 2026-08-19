# NEON 형성평가 시스템

2022 개정 교육과정 중학교 과학 · 수업 주제를 넣으면 형성평가 10문항이 만들어지고, 학생이 풀면 자동 채점되어 데이터가 쌓입니다.

- **문항 생성** — 2022 개정 성취기준 23개 영역·87개 성취기준 내장. Gemini API로 객관식 8 + 단답형 2 (난이도 하3/중5/상2)
- **자동 채점** — 학생 제출 즉시 점수·성취수준·문항별 해설 표시
- **누적 데이터** — 구글 스프레드시트에 계속 저장. 학급별 평균, 문항별 정답률, 최다 오답 분석
- **동시 접속 대응** — 학생 화면은 GitHub Pages(CDN)에서, 데이터만 Apps Script에서

---

## 구조

```
┌─────────────────────┐        ┌──────────────────────┐
│  GitHub Pages       │        │  Google Apps Script  │
│  (정적 CDN, 무제한) │ ─────▶ │  (JSON API)          │
│                     │  fetch │                      │
│  index.html   학생  │        │  Code.gs             │
│  dashboard.html 교사│        │  Standards.gs        │
│  assets/            │        │  Teacher.html  교사  │
└─────────────────────┘        └──────────┬───────────┘
                                          │
                                 ┌────────▼─────────┐
                                 │ Google Sheets    │
                                 │ 문제은행 / 응답   │
                                 └──────────────────┘
```

| 화면 | 어디에 | 주소 |
|---|---|---|
| 학생 응시 | GitHub Pages | `https://<아이디>.github.io/<저장소>/?id=Q...` |
| 교사 대시보드 | GitHub Pages | `https://<아이디>.github.io/<저장소>/dashboard.html` |
| 교사 출제실 | Apps Script | 웹 앱 `/exec` 주소 |

---

## 설치

전체 절차는 **[docs/설치_매뉴얼.md](docs/설치_매뉴얼.md)** 에 있습니다. 요약하면:

1. **GitHub** — 새 저장소 만들기 → 이 폴더의 파일 전부 업로드 → Settings → Pages → Branch `main` / `/ (root)` → Save
2. **Google 스프레드시트** — 새로 만들기 → 확장 프로그램 → Apps Script
3. **Apps Script** — `apps-script/` 안의 3개 파일 붙여넣기 → `setup` 실행 → 웹 앱으로 배포(액세스: **모든 사용자**)
4. **config.js** — GitHub에서 `config.js` 를 열어 `API_URL` 에 웹 앱 `/exec` 주소를 붙여넣고 커밋
5. **출제실 설정 탭** — Gemini API 키 / GitHub Pages 주소 / 교사 PIN 입력

---

## 파일

```
├── index.html              학생 응시 화면 (GitHub Pages 첫 화면)
├── dashboard.html          교사 대시보드 (PIN 보호)
├── config.js               ⚙ API_URL 한 줄만 수정
├── assets/
│   ├── neon.css            네온사인 공용 스타일
│   └── api.js              API 클라이언트 (자동 재시도·우회 포함)
├── apps-script/            ← Apps Script 편집기에 붙여넣을 파일
│   ├── Code.gs             API 서버 · 채점 · Gemini 연동
│   ├── Standards.gs        2022 개정 성취기준 87개
│   └── Teacher.html        교사 출제실 UI
└── docs/
    ├── 설치_매뉴얼.md
    ├── 성능_최적화.md      동시 접속이 왜 느렸고 무엇을 고쳤는지
    └── 수업활용_패턴.md    수업에 쓰는 8가지 방법
```

---

## 문항을 고치고 싶을 때

스프레드시트 `문제은행` 시트의 **문항JSON** 칸을 직접 편집한 뒤,
출제실 → 설정 → **🧹 캐시 비우기** 를 누르면 학생 화면에 반영됩니다.

---

## 라이선스

MIT. 학교 현장에서 자유롭게 수정·재배포하세요.

성취기준 원문은 교육부·한국교육과정평가원의 「2022 개정 교육과정에 따른 중학교 과학 성취수준」 자료에서 발췌한 것으로, 해당 자료의 이용 조건을 따릅니다.
