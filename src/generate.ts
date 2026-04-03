import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { ProjectConversation } from "./collect.js";
import { summarizeConversations } from "./summarize.js";
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

  const claudeConversations: ProjectConversation[] = (convRows ?? []).map((row) => ({
    projectName: row.project_name,
    messages: row.messages,
  }));

  console.log(`📦 미처리 Claude 대화: ${claudeConversations.length}개`);

  // 2. Notion 수집 (항상 최신)
  console.log("\n=== 2단계: Notion 수집 ===");
  const notionConversations = await collectNotionContent();

  const allConversations = [...claudeConversations, ...notionConversations];

  if (allConversations.length === 0) {
    console.log("처리할 대화가 없어요!");
    return;
  }

  // 3. Claude API로 초안 생성
  console.log(`\n=== 3단계: 초안 생성 (${allConversations.length}개 대화) ===`);
  const drafts = await summarizeConversations(allConversations);

  if (drafts.length === 0) {
    console.log("생성된 초안 없음");
    return;
  }

  // 4. Supabase draft_posts 저장 (conversation_data 포함)
  console.log("\n=== 4단계: 초안 저장 ===");
  const rows = drafts.map((draft) => ({
    title: draft.title,
    description: draft.description,
    content: draft.content,
    tags: draft.tags.join(","),
    source_project: draft.sourceProject,
    conversation_data: draft.conversation ?? null, // 재생성용 소스 저장
    status: "pending",
    created_at: new Date().toISOString(),
  }));

  const { error: insertError } = await supabase.from("draft_posts").insert(rows);
  if (insertError) throw insertError;

  // 5. Claude 대화 processed 처리
  if (convRows && convRows.length > 0) {
    const ids = convRows.map((r) => r.id);
    await supabase.from("conversations").update({ processed: true }).in("id", ids);
    console.log(`✅ ${ids.length}개 대화 processed 처리`);
  }

  console.log(`\n✨ ${drafts.length}개 초안 생성 완료! 블로그 /admin/drafts 에서 확인해봐~`);
}

main().catch((err) => {
  console.error("💥 generate 에러:", err);
  process.exit(1);
});
