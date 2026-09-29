# 🍠 고구마은행 (학생 통장 웹앱)

학생은 URL만 열면 되고(Claude 로그인 불필요), 데이터는 Cloudflare KV 에 저장돼서
여러 기기에서 함께 쓰고, 새로고침해도 유지돼요.

## 폴더 구조
```
gugu-bank-web/
├─ public/
│   └─ index.html          ← 화면 전체 (학생 화면 + 교사 화면)
├─ functions/
│   ├─ _lib/util.js        ← 로그인 토큰·비밀번호 해시·KV 읽기/쓰기 부품
│   └─ api/
│       ├─ roster.js       ← GET  /api/roster       (로그인 화면의 학생 이름 목록)
│       ├─ login.js        ← POST /api/login        (학생 로그인 / 첫 비밀번호 만들기)
│       ├─ admin-login.js  ← POST /api/admin-login  (교사 로그인)
│       └─ state.js        ← GET/PUT /api/state     (전체 데이터 읽기/저장)
├─ .dev.vars.example       ← (내 컴퓨터 시험용 예시)
├─ .gitignore
└─ README.md
```

## 배포 순서 (GitHub + Cloudflare Pages)
1. 이 폴더 전체를 GitHub 새 저장소(repository)에 올려요. (폴더 안의 파일들이 저장소 맨 위에 오게)
2. Cloudflare 대시보드 → **Workers & Pages → Create → Pages → Connect to Git** → 저장소 선택.
3. 빌드 설정: **Framework preset: None**, **Build command: (비워 둠)**, **Build output directory: `public`** → Save and Deploy.
4. **KV 만들기**: Workers & Pages → **KV → Create a namespace** → 이름 `gugu-bank`.
5. Pages 프로젝트 → **Settings → Bindings(또는 Functions) → Add → KV namespace**
   - Variable name: **`BANK`** (꼭 이 이름, 대문자)
   - KV namespace: 방금 만든 `gugu-bank`
   - Production(과 Preview) 모두 설정.
6. 같은 화면 **Settings → Variables and Secrets** 에 추가 (Secret/암호화 권장):
   - **`ADMIN_PASSWORD`** = 교사 비밀번호
   - **`SESSION_SECRET`** = 아무 긴 문자열 (로그인 표를 만드는 비밀 값. 예: 영문+숫자 30자)
7. **Deployments → 가장 위 배포 → Retry deployment** (변수·바인딩은 다시 배포해야 적용돼요).
8. 발급된 `https://프로젝트이름.pages.dev` 주소를 학생들에게 알려 주면 끝!

## 처음 사용
1. 주소를 열고 **교사 로그인** → ADMIN_PASSWORD 입력.
2. **학생 관리** 탭에서 학생 이름 등록. (이 전에는 학생들이 로그인할 수 없어요)
3. 학생은 이름 선택 → **처음 들어올 때 비밀번호(4자 이상)를 직접 만들어요.**
4. 학생이 비밀번호를 잊으면 학생 관리 → 비밀번호 **초기화**.

## 내 컴퓨터에서 시험해 보기 (선택)
Node.js 설치 후, 이 폴더에서:
```
cp .dev.vars.example .dev.vars      # 값 채우기
npx wrangler pages dev public --kv=BANK
```

## 앱 방식 메모
- 비밀번호는 해시로만 저장되고 브라우저로 내려가지 않아요. 교사 비밀번호는 코드/데이터에 없고 환경변수에만 있어요.
- 로그인 표는 24시간 유효, 브라우저 탭을 닫으면 다시 로그인해요(sessionStorage). 데이터는 localStorage에 저장하지 않아요.
- 화면은 4초마다 자동으로 최신 데이터로 갱신돼요. 두 명이 동시에 저장하면 서버가 충돌을 감지해 자동으로 다시 시도해요.
- 학생 계정은 시장 열기/닫기·종목·직업 목록·수입처 같은 교사 전용 항목을 서버에서 바꿀 수 없게 막아 두었어요.
