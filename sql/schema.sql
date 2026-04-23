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
-- 5. 블로그 UI용 조회 뷰 (선택)
-- =============================================
CREATE OR REPLACE VIEW pending_drafts AS
  SELECT id, title, description, tags, source_project, created_at
  FROM draft_posts
  WHERE status = 'pending'
  ORDER BY created_at DESC;
