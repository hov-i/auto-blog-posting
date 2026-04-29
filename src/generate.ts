import "dotenv/config";
import fs from "fs";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { ProjectConversation } from "./collect.js";
import {
  DraftPost,
  Insight,
  PendingClusterRow,
  StoredInsight,
  extractInsightsFromTechConversations,
  mergeInsightsIntoClusters,
  prefilterPendingClusters,
  toStoredInsight,
} from "./summarize.js";
import { collectNotionContent } from "./collect-notion.js";
import { collectExperiences } from "./collect-experiences.js";
import { summarizeConversations } from "./summarize.js";

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL 또는 KEY가 없어요!");
  return createClient(url, key);
}

async function fetchPendingClusters(
  supabase: SupabaseClient,
): Promise<PendingClusterRow[]> {
  const { data, error } = await supabase
    .from("topic_clusters")
    .select(
      "id, theme, angle, quality_score, insights, source_projects, tech_stack, last_updated_at",
    )
    .eq("is_drafted", false)
    .order("last_updated_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as PendingClusterRow[];
}

async function applyMergeToDb(
  supabase: SupabaseClient,
  existingUpdates: Map<number, Insight[]>,
  pendingMap: Map<number, PendingClusterRow>,
  newClusters: {
    theme: string;
    angle: string;
    qualityScore: number;
    techStack: string[];
    insights: Insight[];
  }[],
): Promise<{ merged: number; created: number }> {
  let merged = 0;
  let created = 0;

  // 기존 클러스터에 인사이트 추가
  for (const [clusterId, addedInsights] of existingUpdates) {
    const existing = pendingMap.get(clusterId);
    if (!existing) continue;

    const mergedInsights: StoredInsight[] = [
      ...existing.insights,
      ...addedInsights.map(toStoredInsight),
    ];
    const mergedProjects = Array.from(
      new Set([
        ...(existing.source_projects ?? []),
        ...addedInsights.map((i) => i.sourceProject),
      ]),
    );
    const mergedTechs = Array.from(
      new Set([
        ...(existing.tech_stack ?? []),
        ...addedInsights.flatMap((i) => i.techStack),
      ]),
    );

    const { error } = await supabase
      .from("topic_clusters")
      .update({
        insights: mergedInsights,
        source_projects: mergedProjects,
        tech_stack: mergedTechs,
        last_updated_at: new Date().toISOString(),
      })
      .eq("id", clusterId);

    if (error) {
      console.error(`  ❌ 클러스터 ${clusterId} 업데이트 실패:`, error.message);
    } else {
      console.log(
        `  🔄 [E${clusterId}] "${existing.theme}" ← +${addedInsights.length}개 인사이트`,
      );
      merged++;
    }
  }

  // 새 클러스터 insert
  if (newClusters.length > 0) {
    const rows = newClusters.map((c) => ({
      theme: c.theme,
      angle: c.angle,
      quality_score: c.qualityScore,
      insights: c.insights.map(toStoredInsight),
      source_projects: Array.from(
        new Set(c.insights.map((i) => i.sourceProject)),
      ),
      tech_stack: Array.from(
        new Set([
          ...c.techStack,
          ...c.insights.flatMap((i) => i.techStack),
        ]),
      ),
      is_drafted: false,
      last_updated_at: new Date().toISOString(),
    }));

    const { data, error } = await supabase
      .from("topic_clusters")
      .insert(rows)
      .select("id, theme");

    if (error) {
      console.error("  ❌ 새 클러스터 insert 실패:", error.message);
    } else {
      for (const r of data ?? []) {
        console.log(`  ✨ [E${r.id}] "${r.theme}" (신규)`);
      }
      created = data?.length ?? 0;
    }
  }

  return { merged, created };
}

async function main() {
  console.log("🚀 블로그 파이프라인 시작!\n");

  const supabase = getSupabaseClient();

  // 1. 미처리 Claude 대화 조회
  console.log("=== 1단계: 미처리 Claude 대화 조회 ===");
  const { data: convRows, error } = await supabase
    .from("conversations")
    .select("*")
    .eq("processed", false)
    .eq("source", "claude");

  if (error) throw error;
  console.log(`📦 미처리 Claude 대화: ${(convRows ?? []).length}개`);

  // 2. Notion 수집
  console.log("\n=== 2단계: Notion 수집 ===");
  const notionConversations = await collectNotionContent();

  // 3. Discord 경험 수집
  console.log("\n=== 3단계: Discord 경험 수집 ===");
  const { conversations: experienceConversations, ids: experienceIds } =
    await collectExperiences();

  if (
    (convRows ?? []).length === 0 &&
    notionConversations.length === 0 &&
    experienceConversations.length === 0
  ) {
    console.log("처리할 대화가 없어요!");
    return;
  }

  // 4. Discord 경험 → 1:1 직접 draft 생성 (변경 없음)
  let experienceDrafts: DraftPost[] = [];
  if (experienceConversations.length > 0) {
    console.log("\n=== 4단계: Discord 경험 → 직접 draft 생성 ===");
    experienceDrafts = await summarizeConversations(experienceConversations, []);
  }

  // 5. 기술 대화(Claude+Notion) → 인사이트 추출 → topic_clusters 누적
  const techConversations: ProjectConversation[] = [
    ...(convRows ?? []).map((row) => ({
      projectName: row.project_name as string,
      messages: row.messages,
    })),
    ...notionConversations,
  ];

  let mergedCount = 0;
  let createdCount = 0;
  if (techConversations.length > 0) {
    console.log("\n=== 5단계: 기술 대화 → 인사이트 추출 ===");
    const newInsights = await extractInsightsFromTechConversations(
      techConversations,
    );
    console.log(`📦 총 ${newInsights.length}개 인사이트 수집`);

    if (newInsights.length > 0) {
      console.log("\n=== 6단계: 기존 pending 클러스터 조회 + 머지 ===");
      const pending = await fetchPendingClusters(supabase);
      console.log(`📋 pending 클러스터 ${pending.length}개`);

      const candidates = prefilterPendingClusters(newInsights, pending, 8);
      console.log(`🎯 1차 필터 후 후보 ${candidates.length}개`);

      const mergeResult = await mergeInsightsIntoClusters(
        newInsights,
        candidates,
      );

      const pendingMap = new Map(pending.map((c) => [c.id, c]));
      const { merged, created } = await applyMergeToDb(
        supabase,
        mergeResult.existingUpdates,
        pendingMap,
        mergeResult.newClusters,
      );
      mergedCount = merged;
      createdCount = created;
    }
  }

  // 6. Discord draft 저장 (있을 때만)
  if (experienceDrafts.length > 0) {
    console.log("\n=== 7단계: Discord draft 저장 ===");
    const rows = experienceDrafts.map((draft) => ({
      title: draft.title,
      description: draft.description,
      content: draft.content,
      tags: draft.tags.join(","),
      source_project: draft.sourceProject,
      conversation_data: draft.conversation ?? null,
      status: "pending",
      created_at: new Date().toISOString(),
    }));
    const { error: insertError } = await supabase
      .from("draft_posts")
      .insert(rows);
    if (insertError) throw insertError;
    console.log(`✨ ${experienceDrafts.length}개 Discord draft 저장 완료`);
  }

  // 7. processed 처리
  const claudeIds: string[] = (convRows ?? []).map((row) => row.id);
  if (claudeIds.length > 0) {
    await supabase
      .from("conversations")
      .update({ processed: true })
      .in("id", claudeIds);
    console.log(`✅ ${claudeIds.length}개 Claude 대화 processed 처리`);
  }
  if (experienceIds.length > 0) {
    await supabase
      .from("experiences")
      .update({ processed: true })
      .in("id", experienceIds);
    console.log(`✅ ${experienceIds.length}개 Discord 경험 processed 처리`);
  }

  // 8. GitHub Actions Job Summary
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    const lines = [
      `## 블로그 파이프라인 결과`,
      ``,
      `- 새 클러스터: **${createdCount}개**`,
      `- 기존 클러스터 머지: **${mergedCount}개**`,
      `- Discord draft 생성: **${experienceDrafts.length}개**`,
      ``,
      `topic_clusters는 \`is_drafted=false\` 상태로 admin 페이지에서 발제 대상.`,
    ];
    fs.appendFileSync(summaryFile, lines.join("\n") + "\n");
  }

  console.log(
    `\n🎉 완료! 클러스터 신규 ${createdCount}, 머지 ${mergedCount}, Discord draft ${experienceDrafts.length}`,
  );
}

main().catch((err) => {
  console.error("💥 generate 에러:", err);
  process.exit(1);
});
