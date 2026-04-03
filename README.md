# Auto Blog Posting Pipeline

Claude Code 대화 로그와 Notion 글을 자동으로 블로그 초안으로 변환하는 파이프라인.

---

## 전체 파이프라인 흐름

```mermaid
flowchart TD
    A([Claude Code 대화 종료]) -->|Stop Hook 자동 발동| B

    subgraph STEP1["STEP 1 · 수집 — 로컬 맥 · 무료"]
        B[sync.ts 실행]
        B --> C{새 대화?}
        C -->|이미 동기화됨| D[⏭스킵]
        C -->|메시지 5개 미만| D
        C -->|새 대화 발견!| E[(Supabase\nconversations\nprocessed: false)]
    end

    E -->|데이터 축적| F

    subgraph STEP2["STEP 2 · 생성 — GitHub Actions · 주 1회"]
        F([매주 월요일 09:00 KST])
        F --> G[generate.ts 실행]
        G --> H[(Supabase\nprocessed: false\n대화 조회)]
        G --> I[Notion API\n새 글 수집]
        H --> J[Claude API 호출\nclaude-sonnet-4-6]
        I --> J
        J --> K[(Supabase\ndraft_posts\nstatus: pending\nconversation_data 포함)]
        K --> L[conversations\nprocessed: true]
    end

    K --> M

    subgraph STEP3["STEP 3 · 리뷰 — 블로그 UI · 비선형"]
        M([/admin/drafts 접속])
        M --> N[초안 목록 확인]
        N --> O{선택}
        O -->|발제하기| P[Prisma post 생성\n블로그에 게시!]
        O -->|삭제| Q[draft 삭제]
        O -->|재생성| R[conversation_data 꺼냄\nClaude API 재호출]
        R --> S[새 초안으로 업데이트\nUI 즉시 반영]
        S --> N
    end
```

---

## 데이터 흐름

```mermaid
flowchart LR
    subgraph LOCAL["로컬 맥"]
        A["~/.claude/projects\n*.jsonl 파일들"]
    end

    subgraph SUPABASE["Supabase"]
        B[("conversations\n─────────\nproject_name\nfile_key\nmessages\nprocessed: false")]
        C[("draft_posts\n─────────\ntitle / content\ntags / description\nconversation_data ← 재생성용\nstatus: pending")]
    end

    subgraph CLOUD["GitHub Actions (주 1회)"]
        D["generate.ts\n+ Notion API"]
        E["Claude API\nclaude-sonnet-4-6"]
    end

    subgraph BLOG["블로그 UI"]
        F["/admin/drafts\n초안 검토"]
        G["Prisma Posts\n발행됨"]
    end

    A -->|"npm run sync\n(Stop Hook 자동)"| B
    B -->|"미처리 대화 조회"| D
    D --> E
    E -->|"초안 저장"| C
    C -->|"검토"| F
    F -->|"발제하기"| G
    F -->|"재생성"| C
```

---

## 비용 구조

| 단계          | 실행 시점        | Claude API | 비용        |
| ------------- | ---------------- | ---------- | ----------- |
| `sync.ts`     | 대화 끝날 때마다 | 없음       | 거의 0      |
| `generate.ts` | 주 1회           | 사용       | 주 1회만    |
| 재생성        | 버튼 클릭 시     | 사용       | 필요할 때만 |

---

## 디렉토리 구조

```
auto-blog-posting/
│
├── src/
│   ├── sync.ts            # STEP 1: 로컬 로그 → Supabase 동기화
│   ├── generate.ts        # STEP 2: Supabase 대화 → 블로그 초안 생성
│   ├── collect.ts         # 로컬 ~/.claude/projects/ 파일 파싱
│   ├── collect-notion.ts  # Notion API에서 글 수집
│   ├── summarize.ts       # Claude API 호출 + 블로그 스타일 프롬프트
│   ├── upload-drafts.ts   # Supabase draft_posts 저장
│   └── index.ts           # 로컬 전체 파이프라인 수동 실행용
│
├── .github/
│   └── workflows/
│       └── blog-pipeline.yml  # 매주 월요일 자동 실행
│
├── sql/
│   └── schema.sql         # Supabase 테이블 생성 SQL
│
├── setup-hook.sh          # Claude Code Stop Hook 등록 스크립트
└── .env                   # 환경변수 (절대 커밋 금지!)
```

---

## 초기 설정 방법

### 1. 환경변수 설정

`.env` 파일 생성:

```env
ANTHROPIC_API_KEY=sk-ant-...
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
NOTION_API_KEY=secret_...
NOTION_DATABASE_ID=...
```

### 2. Supabase 테이블 생성

Supabase 대시보드 → SQL Editor → `sql/schema.sql` 내용 실행

### 3. 의존성 설치

```bash
npm install
```

### 4. Stop Hook 등록 (최초 1회)

```bash
bash setup-hook.sh
```

Claude Code 대화가 끝날 때마다 `sync.ts`가 백그라운드에서 자동 실행됨.

### 5. GitHub 레포 생성 후 Secrets 등록

레포 → Settings → Secrets and variables → Actions:

```
ANTHROPIC_API_KEY
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
NOTION_API_KEY
NOTION_DATABASE_ID
```

### 6. 블로그 Vercel 환경변수 추가

Vercel 대시보드 → 블로그 프로젝트 → Settings → Environment Variables:

```
ANTHROPIC_API_KEY=sk-ant-...
```

---

## 수동 실행 명령어

```bash
# 로컬 로그를 Supabase에 동기화
npm run sync

# 미처리 대화로 블로그 초안 생성
npm run generate

# 로컬에서 전체 파이프라인 한 번에 실행
npm run start
```

---

## GitHub Actions 스케줄

- 실행 시점: **매주 월요일 오전 9시 KST** (UTC 0:00)
- 수동 실행: GitHub 레포 → Actions 탭 → `블로그 초안 자동 생성` → `Run workflow`

---

## 재생성 동작 방식

```mermaid
sequenceDiagram
    actor 언냐
    participant UI as 블로그 /admin/drafts
    participant API as Next.js Server Action
    participant DB as Supabase draft_posts
    participant Claude as Claude API

    언냐->>UI: 재생성 버튼 클릭
    UI->>API: regenerateDraft(draftId)
    API->>DB: conversation_data 조회
    DB-->>API: 원본 대화 JSON 반환
    API->>Claude: 동일 대화로 재생성 요청
    Claude-->>API: 새 블로그 초안 반환
    API->>DB: title / content / tags 업데이트
    API-->>UI: 새 내용 즉시 반환
    UI->>언냐: 화면 즉시 업데이트 (새로고침 없음)
    언냐->>언냐: 마음에 들면 발제, 아니면 다시 재생성!
```
