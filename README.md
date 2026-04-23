# Auto Blog Posting Pipeline

Claude Code 대화 로그, Notion 글, Discord 경험 후기를 자동으로 블로그 초안으로 변환하는 파이프라인.

---

## 전체 파이프라인 흐름

```mermaid
flowchart TD
    subgraph SOURCE["입력 소스 (3가지)"]
        S1([Claude Code 대화 종료\nStop Hook 자동])
        S2([Notion 글 수정])
        S3([캘린더 일정 종료\nApps Script 감지])
    end

    subgraph STEP1A["STEP 1-A · 기술 대화 수집 — 로컬 맥 · 무료"]
        S1 -->|Stop Hook| B[sync.ts 실행]
        B --> C{새 대화?}
        C -->|이미 동기화됨| D[스킵]
        C -->|메시지 5개 미만| D
        C -->|새 대화 발견!| E[(Supabase\nconversations\nprocessed: false)]
    end

    subgraph STEP1B["STEP 1-B · 경험 후기 수집 — GitHub Actions · 매시간"]
        S3 -->|repository_dispatch| GH1[discord-notify job\n Discord 스레드 생성\n + experience_threads 저장]
        GH1 --> DC[Discord 스레드에\n후기 작성]
        DC -->|매시간 cron| GH2[collect job\ncollect-discord.ts]
        GH2 -->|이미지 → Supabase Storage| EX[(Supabase\nexperiences\nprocessed: false)]
    end

    E -->|데이터 축적| F
    EX -->|데이터 축적| F

    subgraph STEP2["STEP 2 · 생성 — GitHub Actions · 주 1회 or 수동"]
        F([매주 월요일 09:00 KST\nor workflow_dispatch])
        F --> G[generate.ts 실행]
        G --> G1[기존 draft_posts 주제 조회\n중복 방지용]
        G --> H[(conversations\nprocessed: false 조회)]
        G --> I[Notion API\n이번 주 수정 글 수집]
        G --> EXQ[(experiences\nprocessed: false 조회)]

        EXQ --> EXPIPE["경험 후기 파이프라인\n필터링 없이 바로 글 생성\nclaude-sonnet-4-6"]
        H --> J["1단계: 인사이트 추출\nclaude-haiku-4-5 병렬"]
        I --> J
        J --> K["2단계: 주제별 클러스터링 + 품질 점수\nclaude-sonnet-4-6 1회"]
        G1 --> K
        K --> K2{품질 점수 3 이상?}
        K2 -->|미만| D2[스킵]
        K2 -->|이상| L["3단계: 블로그 글 생성\nclaude-sonnet-4-6 병렬"]
        L --> M[(draft_posts\nstatus: pending)]
        EXPIPE --> M
    end

    M --> O

    subgraph STEP3["STEP 3 · 리뷰 — 블로그 UI · 비선형"]
        O([/admin/drafts 접속])
        O --> P[초안 목록 확인]
        P --> Q{선택}
        Q -->|발제하기| R[Prisma post 생성\n블로그에 게시]
        Q -->|삭제| S[draft 삭제]
        Q -->|재생성| T[conversation_data 꺼냄\nClaude API 재호출]
        T --> U[새 초안으로 업데이트\nUI 즉시 반영]
        U --> P
    end
```

---

## AI 처리 파이프라인 상세

### 기술 대화 파이프라인 (Claude 로그 + Notion)

```mermaid
flowchart LR
    subgraph EXTRACT["1단계: 인사이트 추출 (Haiku, 병렬 최대 5개)"]
        A1[대화 1] --> E1["인사이트 A, B"]
        A2[대화 2] --> E2["인사이트 C"]
        A3[대화 3] --> E3["인사이트 D, E"]
    end

    subgraph CLUSTER["2단계: 클러스터링 + 품질 점수 (Sonnet, 1회)"]
        E1 & E2 & E3 --> CL["주제별 그루핑\n+ 기존 글 중복 제거\n+ 품질 점수 1-5"]
        CL --> C1["클러스터 1\n점수 4/5 ✅"]
        CL --> C2["클러스터 2\n점수 2/5 ⏭️ 스킵"]
    end

    subgraph GENERATE["3단계: 글 생성 (Sonnet, 병렬 최대 3개)"]
        C1 --> P1["블로그 글 1\n다중 프로젝트 합성"]
    end
```

**파이프라인 특징:**
- 여러 프로젝트에 걸쳐 비슷한 주제 → 하나의 깊은 글로 합성
- `cleanConversationText`로 코드블록 압축, 짧은 메시지 제거 후 Haiku 전달
- Haiku로 가치 없는 대화 사전 필터링 → 비용 절감
- Sonnet이 클러스터링 시 품질 점수(1-5) 부여 → 3점 미만은 생성 스킵
- Tool Use 강제 → JSON 파싱 오류 원천 차단
- 기존 draft_posts 제목 참조 → 중복 주제 생성 방지

### 경험 후기 파이프라인 (Discord)

```mermaid
flowchart LR
    DC["Discord 스레드\n후기 메시지들"] --> EX["experiences 테이블\n(이미지 포함)"]
    EX --> GEN["generateFromExperience\nclaude-sonnet-4-6"]
    GEN --> DP["draft_posts"]
```

**경험 후기는 필터링 없음:** 가치 판별·클러스터링을 거치지 않고 바로 블로그 글 생성. 짧은 후기라도 무조건 초안 생성.

---

## 경험 후기 자동화 흐름 (캘린더 → Discord → 블로그)

```mermaid
sequenceDiagram
    actor 언냐
    participant Cal as Google Calendar
    participant GAS as Google Apps Script
    participant GH as GitHub Actions
    participant DC as Discord
    participant DB as Supabase
    participant Claude as Claude API

    언냐->>Cal: 일정 등록
    Cal-->>GAS: 일정 시작 감지 (onCalendarEventCreated)
    GAS->>GAS: 일정 종료 시각에 time-based trigger 예약
    Note over GAS: 일정 종료 시
    GAS->>GH: repository_dispatch (calendar-event-ended)
    GH->>DC: 스레드 생성 + 안내 메시지
    GH->>DB: experience_threads 저장
    언냐->>DC: 후기 작성 (텍스트 + 이미지)
    Note over GH: 매시간 cron
    GH->>DC: 스레드 메시지 수집
    GH->>DB: 이미지 → Supabase Storage 업로드
    GH->>DB: experiences 저장
    Note over GH: 매주 월요일
    GH->>DB: experiences 조회
    GH->>Claude: 블로그 초안 생성
    GH->>DB: draft_posts 저장
```

---

## 데이터 흐름

```mermaid
flowchart LR
    subgraph LOCAL["로컬 맥"]
        A["~/.claude/projects\n*.jsonl 파일들"]
    end

    subgraph DISCORD["Discord"]
        DC["경험 후기 스레드"]
    end

    subgraph SUPABASE["Supabase"]
        B[("conversations\n─────────\nproject_name / file_key\nmessages\nprocessed")]
        EX[("experiences\n─────────\ndiscord_message_id\ncontent / image_urls\ncalendar_event_title\nprocessed")]
        ET[("experience_threads\n─────────\nevent_title\ndiscord_thread_id")]
        C[("draft_posts\n─────────\ntitle / content\ntags / description\nconversation_data\nstatus: pending")]
        IMG[("Storage\nexperience-images")]
    end

    subgraph CLOUD["GitHub Actions"]
        N["Notion API\n이번 주 수정 글"]
        D["generate.ts\n기술 대화 파이프라인"]
        DE["generate.ts\n경험 후기 파이프라인"]
        E["Claude API\nHaiku + Sonnet"]
    end

    subgraph BLOG["블로그 UI"]
        F["/admin/drafts\n초안 검토"]
        G["Prisma Posts\n발행됨"]
    end

    A -->|"npm run sync\n(Stop Hook 자동)"| B
    DC -->|"매시간 collect job"| IMG
    DC -->|"매시간 collect job"| EX
    ET -->|"수집 대상 스레드"| DC
    N -->|"직접 수집"| D
    B -->|"미처리 대화 조회"| D
    EX -->|"미처리 경험 조회"| DE
    D --> E
    DE --> E
    E -->|"품질 통과한 것만"| C
    C -->|"검토"| F
    F -->|"발제하기"| G
    F -->|"재생성"| C
```

---

## 비용 구조

| 단계 | 실행 시점 | 모델 | 역할 |
|---|---|---|---|
| `sync.ts` | 대화 끝날 때마다 | 없음 | 로컬 파일 → DB |
| `collect-discord.ts` | 매시간 | 없음 | Discord 메시지 수집 + 이미지 업로드 |
| 인사이트 추출 | 주 1회 | claude-haiku-4-5 (병렬 최대 5개) | 가치 판별 + 핵심 추출 |
| 클러스터링 | 주 1회 | claude-sonnet-4-6 (1회) | 주제별 그루핑 + 품질 점수 + 중복 제거 |
| 글 생성 (기술) | 주 1회 | claude-sonnet-4-6 (병렬 최대 3개) | 블로그 초안 작성 |
| 글 생성 (경험) | 주 1회 | claude-sonnet-4-6 (병렬) | 필터링 없이 바로 초안 작성 |
| 재생성 | 버튼 클릭 시 | claude-sonnet-4-6 | 단일 초안 재작성 |

---

## GitHub Actions 구조

| Job | 트리거 | 역할 |
|---|---|---|
| `discord-notify` | `repository_dispatch` (캘린더 일정 종료) | Discord 스레드 생성 |
| `collect` | 매시간 cron / `workflow_dispatch job=collect\|all` | Discord 메시지 수집 |
| `generate` | 매주 월요일 cron / `workflow_dispatch job=generate\|all` | 블로그 초안 생성 (`collect` 완료 후 실행) |

`job=all`로 수동 실행 시 `collect → generate` 순서 보장 (`needs: [collect]`).

---

## 디렉토리 구조

```
auto-blog-posting/
│
├── src/
│   ├── sync.ts                 # STEP 1-A: 로컬 로그 → Supabase 동기화
│   ├── generate.ts             # STEP 2: Supabase 대화 + 경험 → 블로그 초안 생성
│   ├── collect.ts              # 로컬 ~/.claude/projects/ 파일 파싱
│   ├── collect-notion.ts       # Notion API에서 글 수집
│   ├── collect-discord.ts      # STEP 1-B: Discord 스레드 메시지 수집 + 이미지 업로드
│   ├── collect-experiences.ts  # Supabase experiences 조회 → ProjectConversation 변환
│   ├── discord-notify.ts       # Discord 스레드 생성 + experience_threads 저장
│   ├── summarize.ts            # 인사이트 추출 + 클러스터링 + 글 생성 (기술 + 경험 분기)
│   ├── upload-drafts.ts        # Supabase draft_posts 저장
│   └── index.ts                # 로컬 전체 파이프라인 수동 실행용
│
├── apps-script/
│   └── calendar-discord.gs     # Google Apps Script: 캘린더 감지 → GitHub Actions 트리거
│
├── .github/
│   └── workflows/
│       └── blog-pipeline.yml   # 3개 job: discord-notify / collect / generate
│
├── sql/
│   └── schema.sql              # Supabase 테이블 생성 SQL
│
├── setup-hook.sh               # Claude Code Stop Hook 등록 스크립트
└── .env                        # 환경변수 (절대 커밋 금지!)
```

---

## 초기 설정 방법

### 1. 환경변수 설정

`.env` 파일 생성:

```env
# Claude API
ANTHROPIC_API_KEY=sk-ant-...

# Supabase
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# Notion (선택)
NOTION_API_KEY=secret_...
NOTION_PAGE_IDS=page_id1,page_id2
NOTION_DATABASE_IDS=db_id1

# Discord (경험 후기 파이프라인)
DISCORD_BOT_TOKEN=...
DISCORD_EXPERIENCE_CHANNEL_IDS=channel_id1,channel_id2

# Google Calendar (경험 후기 파이프라인)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
GOOGLE_CALENDAR_ID=...@group.calendar.google.com
```

### 2. Supabase 테이블 생성

Supabase 대시보드 → SQL Editor → `sql/schema.sql` 내용 실행

경험 후기 파이프라인을 사용한다면 Supabase Storage에 `experience-images` 버킷도 생성 (Public).

### 3. 의존성 설치

```bash
npm install
```

### 4. Stop Hook 등록 (최초 1회)

```bash
bash setup-hook.sh
```

Claude Code 대화가 끝날 때마다 `sync.ts`가 백그라운드에서 자동 실행됩니다.
기존에 등록된 다른 Stop Hook은 유지되며, 중복 실행해도 안전합니다.

### 5. GitHub 레포 Secrets 등록

레포 → Settings → Secrets and variables → Actions:

```
# 필수
ANTHROPIC_API_KEY
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY

# Notion (선택)
NOTION_API_KEY
NOTION_PAGE_IDS
NOTION_DATABASE_IDS

# Discord 경험 후기 (선택)
DISCORD_BOT_TOKEN
DISCORD_EXPERIENCE_CHANNEL_IDS

# Google Calendar 연동 (선택)
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REFRESH_TOKEN
GOOGLE_CALENDAR_ID
```

### 6. Google Apps Script 설정 (경험 후기 파이프라인)

1. [Google Apps Script](https://script.google.com) → 새 프로젝트
2. `apps-script/calendar-discord.gs` 내용 붙여넣기
3. 스크립트 상단 상수 설정:
   ```javascript
   const GITHUB_TOKEN = "ghp_...";  // repo scope 필요
   const GITHUB_REPO = "username/auto-blog-posting";
   const CALENDAR_ID = "...@group.calendar.google.com";
   ```
4. `onCalendarEventCreated` 함수에 캘린더 트리거 등록 (캘린더 업데이트 시 실행)
5. 배포 → 웹 앱으로 배포

### 7. 블로그 Vercel 환경변수 추가

Vercel 대시보드 → 블로그 프로젝트 → Settings → Environment Variables:

```
ANTHROPIC_API_KEY=sk-ant-...
```

---

## 수동 실행 명령어

```bash
# 로컬 로그를 Supabase에 동기화
npm run sync

# Discord 스레드 메시지 수집
npm run collect:discord

# 미처리 대화 + 경험으로 블로그 초안 생성
npm run generate

# 특정 이벤트로 Discord 스레드 수동 생성
EVENT_TITLE="일정 이름" npm run discord:notify
```

---

## GitHub Actions 실행 방법

GitHub 레포 → **Actions** 탭 → **블로그 초안 자동 생성** → **Run workflow**

| `job` 입력값 | 동작 |
|---|---|
| `all` (기본) | collect → generate 순서로 실행 |
| `collect` | Discord 메시지 수집만 |
| `generate` | 블로그 초안 생성만 |

실행 결과는 Actions → 해당 실행 → **Job Summary**에서 생성된 초안 목록 확인 가능.

---

## 재생성 동작 방식

```mermaid
sequenceDiagram
    actor User
    participant UI as 블로그 /admin/drafts
    participant API as Next.js Server Action
    participant DB as Supabase draft_posts
    participant Claude as Claude API

    User->>UI: 재생성 버튼 클릭
    UI->>API: regenerateDraft(draftId)
    API->>DB: conversation_data 조회
    DB-->>API: 원본 대화 JSON 반환
    API->>Claude: 동일 대화로 재생성 요청
    Claude-->>API: 새 블로그 초안 반환
    API->>DB: title / content / tags 업데이트
    API-->>UI: 새 내용 즉시 반환
    UI->>User: 화면 즉시 업데이트 (새로고침 없음)
```
