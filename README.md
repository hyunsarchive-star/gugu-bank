# 우리 반 과제함 (웹 버전)

학생들이 Claude 로그인 없이 **주소(URL)만으로** 쓰는 학급 웹앱이에요.
화면은 HTML/CSS/JavaScript, 저장은 **Cloudflare Pages Functions + D1**을 써요.
여러 학생이 각자 다른 기기에서 들어와도 같은 데이터를 보고, 새로고침해도 그대로 남아요.

## 폴더 구조

```
uri-ban/
├── public/                  ← 화면 (Cloudflare Pages 출력 폴더)
│   ├── index.html           ← 앱 전체 화면 (학생 화면 + 선생님 화면)
│   └── db.js                ← 서버와 데이터를 주고받는 연결 코드
├── functions/
│   └── api/
│       └── [[path]].js      ← 서버 (/api/... 주소 전부 처리)
├── schema.sql               ← 데이터베이스 표 구조 (참고용, 자동 생성돼요)
└── README.md                ← 이 설명서
```

> `[[path]].js` 는 대괄호 두 개까지 **파일 이름 그대로** 써야 해요.

## 배포 순서 (한 번만 하면 돼요)

### 1. GitHub에 올리기
1. GitHub에서 **New repository** → 이름(예: `uri-ban`) → **Private** 추천 → Create.
2. **Add file → Upload files** 에서 `uri-ban` 폴더 **안의 내용**(public, functions, schema.sql, README.md)을 끌어다 놓고 **Commit changes**.
3. 올린 뒤 `functions/api/[[path]].js` 경로가 그대로인지 확인해요.

### 2. Cloudflare Pages 만들기
1. Cloudflare 대시보드 → **Workers & Pages → Create → Pages → Connect to Git**.
2. 방금 만든 저장소 선택.
3. 빌드 설정:
   - Framework preset: **None**
   - Build command: **(비워 두기)**
   - Build output directory: **`public`**
4. **Save and Deploy**.

### 3. D1 데이터베이스 만들고 연결하기
1. 대시보드 → **Storage & Databases → D1 → Create database** → 이름 `uri-ban-db`.
2. Pages 프로젝트 → **Settings → Bindings → Add → D1 database**
   - Variable name: **`DB`** (꼭 대문자 DB)
   - D1 database: `uri-ban-db`
3. 표는 첫 접속 때 자동으로 만들어져요. 따로 SQL을 실행하지 않아도 돼요.

### 4. 환경변수(비밀번호) 넣기
Pages 프로젝트 → **Settings → Variables and Secrets → Add** (Type은 **Secret**)

| 이름 | 내용 | 필수 |
|---|---|---|
| `ADMIN_PASSWORD` | 선생님 비밀번호 | 꼭 필요 |
| `SESSION_SECRET` | 아무 긴 글자 (예: 무작위 40자). 로그인 정보를 서명하는 데 써요 | 권장 |

비밀번호는 코드 안에 없고 여기에만 저장돼요. 바꾸고 싶으면 여기서 값을 바꾸면 돼요.
(`SESSION_SECRET`을 넣지 않으면 `ADMIN_PASSWORD`로 대신 서명해요. 비밀번호를 바꾸면 모두 다시 로그인해야 해요.)

### 5. 다시 배포
바인딩과 환경변수는 **새 배포부터** 적용돼요.
Pages 프로젝트 → **Deployments → 최신 배포의 ⋯ → Retry deployment**.

### 6. 확인
- `https://프로젝트이름.pages.dev/api/health` 에 들어가서 `{"ok":true,"configured":true}` 가 보이면 성공이에요.
- 사이트에 들어가 오른쪽 위 **🔒 선생님 로그인** → `ADMIN_PASSWORD` → **학생 관리** 탭에서 명단을 등록해요.
- 학생들에게는 같은 주소만 알려 주면 돼요. 처음 이름을 누르면 각자 비밀번호를 만들어요.

## Claude 버전에서 데이터 옮기기
1. Claude에 있던 과제함 → **학생 관리 → 파일로 내려받기**
2. 웹 버전에서 선생님 로그인 → **학생 관리 → 파일에서 복원** → 그 파일 선택
학생 명단, 학생 비밀번호, 과제·사진·체크 기록이 그대로 옮겨져요.

## 저장 방식과 권한 (서버가 직접 지켜요)
- 모든 데이터는 D1의 `docs` 표에 저장되고, 화면은 `/api/sync` 로 실시간(1~2초 안)으로 바뀐 내용만 받아와요.
- **로그인 전:** 학생 이름 목록만 볼 수 있어요.
- **학생:** 자기 제출물, 자기 체크, 자기 답만 저장할 수 있어요. 친구 글에는 ❤️만 누를 수 있어요. 누가기록·백업은 볼 수 없어요.
- **검사 도우미 학생:** 맡은 할 일의 친구 칸만, 맡은 기간 동안만 체크할 수 있어요.
- **선생님:** 모든 것을 보고 바꿀 수 있어요.
- 학생 비밀번호는 암호화된 값으로만 저장되고, 선생님도 원래 비밀번호는 볼 수 없어요. 초기화만 할 수 있어요.
- 비밀번호를 5번 틀리면 30초 동안 막혀요.

## API 목록 (`/api/...`)
| 주소 | 하는 일 |
|---|---|
| `GET /api/health` | 서버 상태 확인 |
| `POST /api/login` | 선생님 로그인 (`ADMIN_PASSWORD`) |
| `POST /api/student/login` | 학생 로그인 (번호 + 비밀번호) |
| `POST /api/student/setpin` | 학생 비밀번호 만들기 / 바꾸기 |
| `GET /api/sync?since=` | 바뀐 데이터 받아오기 (실시간) |
| `GET /api/list?col=` | 한 종류 전체 읽기 (사진, 백업 등) |
| `GET /api/doc?col=&id=` | 문서 하나 읽기 |
| `POST /api/write` | 저장 / 고치기 / 지우기 |

## 무료 사용량 참고 (Cloudflare 무료 요금제 기준)
- Pages Functions 요청: 하루 10만 번. 화면 하나가 1분에 약 3번 요청해요. 한 반(25명)이 하루 종일 켜 두어도 넉넉해요.
- D1: 저장 5GB, 하루 쓰기 10만 번, 읽기 500만 행.
- 사진은 한 장에 약 200KB로 줄여서 저장해요.

## 서버 없이 화면만 보기
`public/index.html` 을 그냥 열면 서버가 없어서 **체험 모드**로 열려요. 화면은 다 보이지만 새로고침하면 사라져요.
