-- =============================================
-- 1. conversations 테이블 (sync.ts가 저장)
-- =============================================
CREATE TABLE IF NOT EXISTS conversations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project_name TEXT NOT NULL,
  file_key TEXT UNIQUE NOT NULL,      -- 중복 방지 (projectDir/filename.jsonl)
  messages JSONB NOT NULL,
  source TEXT NOT NULL DEFAULT 'claude', -- 'claude' | 'notion'
  processed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS conversations_processed_idx ON conversations (processed, source);

-- =============================================
-- 2. draft_posts 테이블 업데이트
--    (기존 테이블에 컬럼 추가)
-- =============================================
ALTER TABLE draft_posts
  ADD COLUMN IF NOT EXISTS conversation_data JSONB,   -- 재생성용 소스 대화
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending'; -- pending | approved | rejected

-- status 기존 값 마이그레이션 (기존에 'draft' 값이 있던 경우)
UPDATE draft_posts SET status = 'pending' WHERE status = 'draft';

-- =============================================
-- 3. experiences 테이블 (Discord 경험 기록)
-- =============================================
CREATE TABLE IF NOT EXISTS experiences (
  id BIGSERIAL PRIMARY KEY,
  discord_message_id TEXT UNIQUE NOT NULL,
  channel_id TEXT NOT NULL,
  content TEXT NOT NULL,
  image_urls TEXT[] DEFAULT '{}',      -- Supabase Storage 이미지 URL 목록
  calendar_event_title TEXT,           -- 캘린더 일정과 연결된 경우
  processed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS experiences_processed_idx ON experiences (processed);

-- =============================================
-- 4. experience_threads 테이블 (봇이 생성한 스레드 추적)
-- =============================================
CREATE TABLE IF NOT EXISTS experience_threads (
  id BIGSERIAL PRIMARY KEY,
  event_title TEXT NOT NULL,
  calendar_event_id TEXT UNIQUE NOT NULL,  -- 중복 스레드 방지
  discord_thread_id TEXT UNIQUE NOT NULL,
  discord_channel_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE experience_threads ENABLE ROW LEVEL SECURITY;

-- =============================================
-- 5. topic_clusters 테이블 (기술 대화 누적용)
--    - 기술 대화 인사이트를 주제별로 누적
--    - admin이 발제 누르기 전까지 살아 있음
--    - is_drafted=true 되면 admin 페이지에서 숨김
-- =============================================
CREATE TABLE IF NOT EXISTS topic_clusters (
  id BIGSERIAL PRIMARY KEY,
  theme TEXT NOT NULL,                       -- 클러스터 주제 (블로그 글 제목 방향)
  angle TEXT,                                -- 글 작성 방향 (트러블슈팅/비교/회고 등)
  quality_score INTEGER NOT NULL DEFAULT 3,  -- 1-5
  insights JSONB NOT NULL DEFAULT '[]'::jsonb, -- 누적된 인사이트 객체 배열
  source_projects TEXT[] DEFAULT '{}',
  tech_stack TEXT[] DEFAULT '{}',            -- 1차 매칭용 (병합 후보 좁히기)
  is_drafted BOOLEAN NOT NULL DEFAULT FALSE, -- admin이 발제 후 true
  drafted_post_id BIGINT,                    -- 생성된 draft_posts.id 참조 (선택)
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS topic_clusters_drafted_idx
  ON topic_clusters (is_drafted, last_updated_at DESC);
CREATE INDEX IF NOT EXISTS topic_clusters_tech_stack_idx
  ON topic_clusters USING GIN (tech_stack);

-- 주의: RLS 명시적 OFF (draft_posts/conversations 등 기존 테이블과 동일 패턴)
-- Supabase SQL editor가 새 테이블 생성 시 경고 후 RLS를 켤 수 있어서 명시적으로 끔
-- 보안은 어드민 server action 단의 ADMIN_EMAIL 체크 + 클라이언트 노출 안 함으로 의존
ALTER TABLE topic_clusters DISABLE ROW LEVEL SECURITY;

-- =============================================
-- 6. 블로그 UI용 조회 뷰 (선택)
-- =============================================
CREATE OR REPLACE VIEW pending_drafts AS
  SELECT id, title, description, tags, source_project, created_at
  FROM draft_posts
  WHERE status = 'pending'
  ORDER BY created_at DESC;

CREATE OR REPLACE VIEW pending_topic_clusters AS
  SELECT id, theme, angle, quality_score, source_projects, tech_stack,
         jsonb_array_length(insights) AS insight_count,
         last_updated_at, created_at
  FROM topic_clusters
  WHERE is_drafted = FALSE
  ORDER BY last_updated_at DESC;
