import { createClient } from "@supabase/supabase-js";
import { DraftPost } from "./summarize.js";

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error("SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY가 없어요!");
  }

  return createClient(url, key);
}

export async function uploadDrafts(drafts: DraftPost[]): Promise<void> {
  if (drafts.length === 0) {
    console.log("📭 저장할 초안이 없어요!");
    return;
  }

  const supabase = getSupabaseClient();

  const rows = drafts.map((draft) => ({
    title: draft.title,
    description: draft.description,
    content: draft.content,
    tags: draft.tags.join(","),
    source_project: draft.sourceProject,
    status: "draft",
    created_at: new Date().toISOString(),
  }));

  const { error } = await supabase.from("draft_posts").insert(rows);

  if (error) {
    console.error("❌ Supabase 저장 실패:", error.message);
    throw error;
  }

  console.log(`✅ ${drafts.length}개 초안 저장 완료!`);
}
