import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { ProjectConversation } from "./collect.js";
import { DraftPost, summarizeConversations } from "./summarize.js";
import { collectNotionContent } from "./collect-notion.js";

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL 또는 KEY가 없어요!");
  return createClient(url, key);
}

async function main() {
  console.log("🚀 블로그 초안 생성 시작!\n");

  const supabase = getSupabaseClient();

  // 1. 미처리 Claude 대화 조회
  console.log("=== 1단계: 미처리 대화 조회 ===");
  const { data: convRows, error } = await supabase
    .from("conversations")
    .select("*")
    .eq("processed", false)
    .eq("source", "claude");

  if (error) throw error;

  console.log(`📦 미처리 Claude 대화: ${(convRows ?? []).length}개`);

  // 2. Notion 수집 (항상 최신)
  console.log("\n=== 2단계: Notion 수집 ===");
  const notionConversations = await collectNotionContent();

  if ((convRows ?? []).length === 0 && notionConversations.length === 0) {
    console.log("처리할 대화가 없어요!");
    return;
  }

  // 3. 기존 draft_posts 주제 조회 (중복 방지용)
  console.log(`\n=== 3단계: 기존 주제 조회 ===`);
  const { data: existingDrafts } = await supabase
    .from("draft_posts")
    .select("title")
    .order("created_at", { ascending: false })
    .limit(50);

  const existingTopics = (existingDrafts ?? []).map((d) => d.title as string);
  console.log(`📋 기존 주제 ${existingTopics.length}개 로드 (중복 방지용)`);

  // 4. 전체 대화 배치로 묶어서 클러스터링 → 초안 생성
  console.log(`\n=== 4단계: 초안 생성 ===`);
  const claudeConversations: ProjectConversation[] = (convRows ?? []).map((row) => ({
    projectName: row.project_name,
    messages: row.messages,
  }));
  const allConversations = [...claudeConversations, ...notionConversations];

  const allDrafts: DraftPost[] = await summarizeConversations(allConversations, existingTopics);

  // 5. Claude 대화 processed: true (초안 생성 여부 무관하게 처리 완료 표시)
  const claudeIds: number[] = (convRows ?? []).map((row) => row.id);
  if (claudeIds.length > 0) {
    await supabase.from("conversations").update({ processed: true }).in("id", claudeIds);
    console.log(`✅ ${claudeIds.length}개 대화 processed 처리`);
  }

  if (allDrafts.length === 0) {
    console.log("생성된 초안 없음 (블로그 가치 있는 인사이트 없음)");
    return;
  }

  // 6. Supabase draft_posts 저장
  console.log("\n=== 5단계: 초안 저장 ===");
  const rows = allDrafts.map((draft) => ({
    title: draft.title,
    description: draft.description,
    content: draft.content,
    tags: draft.tags.join(","),
    source_project: draft.sourceProject,
    conversation_data: draft.conversation ?? null,
    status: "pending",
    created_at: new Date().toISOString(),
  }));

  const { error: insertError } = await supabase.from("draft_posts").insert(rows);
  if (insertError) throw insertError;

  console.log(`\n✨ ${allDrafts.length}개 초안 생성 완료! 블로그 /admin/drafts 에서 확인해봐~`);
}

main().catch((err) => {
  console.error("💥 generate 에러:", err);
  process.exit(1);
});
