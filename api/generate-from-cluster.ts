// Vercel Serverless Function
// blog-site의 admin "이 주제로 발제" 버튼이 호출
// POST /api/generate-from-cluster
//   body: { clusterId: number }
//   returns: { draftPostId: number, title: string }

import { createClient } from "@supabase/supabase-js";
import { generateDraftFromStoredCluster } from "../src/summarize.js";

interface VercelRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

interface VercelResponse {
  status: (code: number) => VercelResponse;
  json: (body: any) => void;
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase 환경변수 없음");
  return createClient(url, key);
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST만 허용" });
  }

  // 간단한 공유 시크릿 인증 (blog-site에서 동일 토큰으로 호출)
  const expected = process.env.GENERATE_API_TOKEN;
  if (expected) {
    const got = req.headers["authorization"];
    const token = Array.isArray(got)
      ? got[0]
      : (got ?? "").replace(/^Bearer\s+/i, "");
    if (token !== expected) {
      return res.status(401).json({ error: "unauthorized" });
    }
  }

  const clusterId = Number(req.body?.clusterId);
  if (!Number.isFinite(clusterId)) {
    return res.status(400).json({ error: "clusterId 필요" });
  }

  const supabase = getSupabase();

  const { data: cluster, error: fetchErr } = await supabase
    .from("topic_clusters")
    .select("*")
    .eq("id", clusterId)
    .single();

  if (fetchErr || !cluster) {
    return res.status(404).json({ error: "cluster not found" });
  }

  if (cluster.is_drafted) {
    return res
      .status(409)
      .json({ error: "이미 발제된 클러스터", draftedPostId: cluster.drafted_post_id });
  }

  const draft = await generateDraftFromStoredCluster({
    theme: cluster.theme,
    angle: cluster.angle,
    insights: cluster.insights ?? [],
  });

  if (!draft) {
    return res.status(500).json({ error: "본문 생성 실패" });
  }

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
    return res.status(500).json({ error: "draft 저장 실패", detail: insertErr?.message });
  }

  await supabase
    .from("topic_clusters")
    .update({ is_drafted: true, drafted_post_id: inserted.id })
    .eq("id", clusterId);

  return res.status(200).json({
    draftPostId: inserted.id,
    title: draft.title,
  });
}
