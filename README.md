# ONE COLOR 서버

계정, 온라인 대전, 랭킹, 친구, 업적/컬렉션, 시즌, 일일 챌린지를 처리하는 Node.js 서버입니다.
게임 클라이언트(Android · Windows · 웹)는 모두 이 서버 하나에 접속합니다.

> **현재 상태:** 이 저장소에는 서버 코드와 테스트가 있지만, **인터넷에 배포된 서버는 없습니다.**
> 아래 방법으로 직접 배포해야 다른 기기끼리 온라인 기능을 쓸 수 있어요.

## 구성

| 항목 | 내용 |
|---|---|
| 런타임 | Node.js 22 이상 (`node:sqlite`, `node:http` 내장 모듈 사용) |
| 의존성 | `ws` (WebSocket), `nodemailer` (선택, 메일 발송) |
| DB | SQLite 파일 하나 (`DB_PATH`) |
| 프로토콜 | HTTP JSON API `/api/*` + WebSocket `/ws` |

- 비밀번호: scrypt 해시. 세션 토큰은 SHA-256 해시로만 저장, 30일 슬라이딩 만료.
- 이메일 인증/비밀번호 재설정 토큰: 1회용, 만료 시간 있음(24시간 / 1시간).
- 대전: 서버가 시드·시계·입력 수락·점수·승패·레이팅(Elo K=32)을 모두 결정합니다. 클라이언트가 보낸 점수는 쓰지 않습니다.
- 싱글 공식 기록: 서버가 발급한 시드(티켓)로 플레이한 입력 기록을 서버가 같은 엔진(`src/rules/`)으로 다시 계산합니다.
- 가짜 사용자·AI 상대·가짜 점수는 만들지 않습니다. 대기열에 사람이 없으면 계속 기다립니다.

## 로컬 실행

```bash
cd server
npm install
npm start            # http://localhost:8787
npm test             # 25개 테스트 (PARITY_FILE이 없으면 parity 1개는 건너뜀)
```

게임에서 서버 주소 지정: **설정 → 계정 · 서버 → 서버 주소**에 `http://<PC의 IP>:8787` 입력 후 "주소 저장 · 연결 확인".
(기본값은 `project/project.godot`의 `one_color/server_url`, 웹 빌드는 페이지 자신의 주소)

## 환경 변수

`.env.example`을 `.env`로 복사해서 채웁니다. **`.env`는 커밋하지 마세요** (`.gitignore`에 포함됨).
코드에는 비밀번호·API 키·DB 비밀 정보가 들어 있지 않습니다.

| 변수 | 설명 |
|---|---|
| `NODE_ENV` | 운영은 `production` (개발용 메일 확인 엔드포인트가 꺼짐) |
| `PORT`, `HOST` | 수신 포트/주소 |
| `DB_PATH` | SQLite 파일 경로 (백업 대상) |
| `PUBLIC_URL` | 메일 링크에 들어갈 서버 공개 주소 (`https://...`) |
| `CORS_ORIGINS` | 웹 게임을 올린 사이트 주소(쉼표 구분) |
| `WEB_DIR` | 웹 빌드 폴더를 같은 주소에서 함께 제공할 때 |
| `REQUIRE_EMAIL_VERIFICATION` | `true`면 이메일 인증 전 온라인 대전 불가 (SMTP가 설정돼 있을 때만 켜세요) |
| `SMTP_HOST` 등 | 메일 서버. **비워 두면 메일을 보내지 않고**, 앱도 "메일 발송이 설정되지 않음"이라고 표시합니다 |
| `SEASON_LENGTH_DAYS` | 시즌 길이(기본 56일). 끝나면 자동 마감, `scripts/season-rollover.js`로 수동 마감도 가능 |
| `DAILY_TZ_OFFSET_MIN` | 일일 챌린지 날짜 기준 (기본 540 = KST) |

## 배포 (예: VPS + Docker + HTTPS)

```bash
cd server
docker build -t onecolor-server .
docker run -d --name onecolor -p 127.0.0.1:8787:8787 \
  --env-file .env -v onecolor-data:/data onecolor-server
```

앞단에 HTTPS 리버스 프록시를 둡니다 (Caddy 예시, 인증서 자동 발급):

```
api.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Caddy는 WebSocket(`/ws`)도 그대로 전달합니다. Nginx를 쓰면 `/ws`에 `Upgrade`/`Connection` 헤더 전달을 넣으세요.

**HTTPS가 필요한 이유:** Android 9 이상은 일반 `http://` 통신을 막고, HTTPS 페이지(웹 게임)는 `ws://`에 접속할 수 없습니다.
그래서 실제 배포 주소는 `https://`(WebSocket은 자동으로 `wss://`)여야 합니다. `http://`는 같은 PC/LAN 테스트용입니다.

배포 후 게임에 넣을 주소:
- 빌드 기본값으로 넣기: `project/project.godot`의 `[one_color] server_url="https://api.example.com"` 수정 후 다시 빌드
- 웹 빌드: `index.html`에 `<script>window.ONE_COLOR_SERVER="https://api.example.com"</script>` 추가 (또는 `WEB_DIR`로 같은 주소에서 제공)
- 이미 설치된 앱: 설정 → 서버 주소

## 운영 메모

- **백업:** `DB_PATH` 파일(+ `-wal`, `-shm`)을 주기적으로 복사하세요.
- **확장:** 매칭/대전 상태는 프로세스 메모리에 있으므로 서버 프로세스는 1개로 운영합니다. 부하 테스트는 하지 않았습니다.
- **요청 제한:** 인증 IP당 30회/분, 이메일당 10회/분, 메일 발송 3회/10분, 일반 API IP당 600회/분, WebSocket 메시지 제한.
- **계정 삭제:** 앱의 계정 화면에서 비밀번호 확인 후 즉시 삭제됩니다 (기록·친구·인벤토리 포함).

## API 요약

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/health` | 상태, 메일 설정 여부, 지원 모드 |
| POST | `/api/auth/register` · `login` · `logout` | 가입(`username`, `password`, `password_confirm`, 선택 `display_name`·`email`) / 로그인(`login` = 아이디) / 로그아웃 |
| POST | `/api/auth/verify-email` · `resend-verification` | 이메일 인증 |
| POST | `/api/auth/password-reset/request` · `confirm` | 비밀번호 재설정 |
| GET/PATCH/DELETE | `/api/me` | 내 프로필 / 닉네임·장착 변경 / 계정 삭제 |
| POST | `/api/me/link-guest` · `progress` | 게스트 기록 연결, 플레이한 모드 보고 |
| GET | `/api/users/:id` | 다른 사람 프로필 |
| GET/POST/DELETE | `/api/friends…` | 친구 목록·요청·응답·삭제 |
| GET | `/api/leaderboard?board=rating\|winrate\|mode&period=&scope=` | 랭킹 |
| GET | `/api/daily` | 오늘의 챌린지 |
| POST | `/api/runs/start` · `submit` | 검증 기록 티켓 발급 / 제출(재계산) |
| WS | `/ws` | auth, queue, cancel, ready, input, invite, leave_match, ping |
