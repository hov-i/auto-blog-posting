import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { collectWeeklyLogs } from "./collect.js";
import { collectNotionContent } from "./collect-notion.js";
import { summarizeConversations } from "./summarize.js";
import { uploadDrafts } from "./upload-drafts.js";

async function main() {
  console.log("🚀 자동 블로그 포스팅 파이프라인 시작!\n");

  // 1단계: 로컬 로그 수집
  console.log("=== 1단계: 클로드 코드 로그 수집 ===");
  const claudeLogs = collectWeeklyLogs();

  console.log("\n=== 1-2단계: 노션 내용 수집 ===");
  const notionLogs = await collectNotionContent();

  const conversations = [...claudeLogs, ...notionLogs];

  if (conversations.length === 0) {
    console.log("이번 주 수집된 대화가 없어서 종료합니다!");
    return;
  }

  // 2단계: 기존 주제 조회 (중복 방지용)
  console.log("\n=== 2단계: 기존 주제 조회 ===");
  let existingTopics: string[] = [];
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (url && key) {
    const supabase = createClient(url, key);
    const { data } = await supabase
      .from("draft_posts")
      .select("title")
      .order("created_at", { ascending: false })
      .limit(50);
    existingTopics = (data ?? []).map((d) => d.title as string);
    console.log(`📋 기존 주제 ${existingTopics.length}개 로드 (중복 방지용)`);
  } else {
    console.log("⚠️  Supabase 환경변수 없음, 중복 방지 스킵");
  }

  // 3단계: 블로그 초안 생성
  console.log("\n=== 3단계: 블로그 초안 생성 ===");
  const drafts = await summarizeConversations(conversations, existingTopics);

  if (drafts.length === 0) {
    console.log("생성된 초안이 없어서 종료합니다!");
    return;
  }

  // 4단계: Supabase에 draft 저장
  console.log("\n=== 4단계: 초안 저장 ===");
  await uploadDrafts(drafts);

  console.log("\n✨ 파이프라인 완료! 블로그에서 /admin/drafts 확인하세요~");
}

main().catch((err) => {
  console.error("💥 파이프라인 에러:", err);
  process.exit(1);
});
