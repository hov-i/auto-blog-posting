// 로컬 CLI: 특정 topic_clusters row 하나로 블로그 본문 생성 → draft_posts 저장
//
// 사용법:
//   npx tsx src/draft-from-cluster.ts            # 첫 번째 pending cluster 자동 선택
//   npx tsx src/draft-from-cluster.ts <clusterId>

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { generateDraftFromStoredCluster } from "./summarize.js";

async function main() {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const idArg = process.argv[2];
  let clusterId: number;

  if (idArg) {
    clusterId = Number(idArg);
    if (!Number.isFinite(clusterId)) {
      console.error("❌ clusterId가 숫자가 아니에요");
      process.exit(1);
    }
  } else {
    const { data, error } = await supabase
      .from("topic_clusters")
      .select("id, theme, quality_score, last_updated_at, insights")
      .eq("is_drafted", false)
      .order("quality_score", { ascending: false })
      .order("last_updated_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    if (!data || data.length === 0) {
      console.log("⏭️  pending cluster가 없어요!");
      return;
    }
    clusterId = data[0].id;
    console.log(
      `🎯 자동 선택: [${clusterId}] "${data[0].theme}" (quality ${data[0].quality_score}, insights ${(data[0].insights ?? []).length}개)`,
    );
  }

  const { data: cluster, error: fetchErr } = await supabase
    .from("topic_clusters")
    .select("*")
    .eq("id", clusterId)
    .single();
  if (fetchErr || !cluster) {
    console.error("❌ cluster 조회 실패:", fetchErr?.message);
    process.exit(1);
  }
  if (cluster.is_drafted) {
    console.log(
      `⚠️  이미 발제된 cluster (drafted_post_id=${cluster.drafted_post_id})`,
    );
    return;
  }

  console.log(`\n✍️  본문 생성 중...`);
  const draft = await generateDraftFromStoredCluster({
    theme: cluster.theme,
    angle: cluster.angle,
    insights: cluster.insights ?? [],
  });
  if (!draft) {
    console.error("❌ 본문 생성 실패");
    process.exit(1);
  }

  console.log(`\n📝 생성된 draft 미리보기`);
  console.log("title:", draft.title);
  console.log("description:", draft.description);
  console.log("tags:", draft.tags.join(", "));
  console.log("content (앞 300자):", draft.content.slice(0, 300));
  console.log("...");
  console.log("(총", draft.content.length, "자)");

  const { data: inserted, error: insertErr } = await supabase
    .from("draft_posts")
    .insert({
      title: draft.title,
      description: draft.description,
      content: draft.content,
      tags: draft.tags.join(","),
      source_project: (cluster.source_projects ?? []).join(", "),
      conversation_data: null,
      status: "pending",
      created_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (insertErr || !inserted) {
    console.error("❌ draft_posts insert 실패:", insertErr?.message);
    process.exit(1);
  }

  await supabase
    .from("topic_clusters")
    .update({ is_drafted: true, drafted_post_id: inserted.id })
    .eq("id", clusterId);

  console.log(`\n✨ draft_posts.id=${inserted.id} 저장 완료`);
  console.log(`✅ topic_clusters.id=${clusterId} 는 is_drafted=true 처리`);
}

main().catch((e) => {
  console.error("💥", e);
  process.exit(1);
});
