import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { ProjectConversation } from "./collect.js";
import { DraftPost, generateDraftPosts, summarizeConversations } from "./summarize.js";
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

  // 3. Claude 대화 병렬 처리 (성공한 것만 processed: true)
  console.log(`\n=== 3단계: 초안 생성 ===`);
  const allDrafts: DraftPost[] = [];
  const successfulIds: number[] = [];

  const claudeResults = await Promise.allSettled(
    (convRows ?? []).map(async (row) => {
      const conversation: ProjectConversation = { projectName: row.project_name, messages: row.messages };
      const drafts = await generateDraftPosts(conversation);
      return { id: row.id, drafts };
    })
  );

  for (const result of claudeResults) {
    if (result.status === "fulfilled" && result.value.drafts.length > 0) {
      allDrafts.push(...result.value.drafts);
      successfulIds.push(result.value.id);
    } else if (result.status === "rejected") {
      console.error("❌ Claude 대화 처리 실패:", result.reason);
    }
  }

  // Notion 초안
  const notionDrafts = await summarizeConversations(notionConversations);
  allDrafts.push(...notionDrafts);

  if (allDrafts.length === 0) {
    console.log("생성된 초안 없음");
    return;
  }

  // 4. Supabase draft_posts 저장 (conversation_data 포함)
  console.log("\n=== 4단계: 초안 저장 ===");
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

  // 5. 성공한 Claude 대화만 processed: true
  if (successfulIds.length > 0) {
    await supabase.from("conversations").update({ processed: true }).in("id", successfulIds);
    console.log(`✅ ${successfulIds.length}개 대화 processed 처리 (실패한 ${(convRows ?? []).length - successfulIds.length}개는 재시도 대상)`);
  }

  console.log(`\n✨ ${allDrafts.length}개 초안 생성 완료! 블로그 /admin/drafts 에서 확인해봐~`);
}

main().catch((err) => {
  console.error("💥 generate 에러:", err);
  process.exit(1);
});
