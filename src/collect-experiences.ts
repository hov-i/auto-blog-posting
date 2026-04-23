import { createClient } from "@supabase/supabase-js";
import { ProjectConversation, Message } from "./collect.js";

interface ExperienceRow {
  id: number;
  channel_id: string;
  content: string;
  calendar_event_title: string | null;
  created_at: string;
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase 환경변수 없음");
  return createClient(url, key);
}

export async function collectExperiences(): Promise<{
  conversations: ProjectConversation[];
  ids: number[];
}> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("experiences")
    .select("id, channel_id, content, calendar_event_title, created_at")
    .eq("processed", false)
    .order("created_at", { ascending: true });

  if (error) throw error;

  const rows = (data ?? []) as ExperienceRow[];

  if (rows.length === 0) {
    console.log("⏭️  미처리 Discord 경험 없음");
    return { conversations: [], ids: [] };
  }

  // channel_id별로 그룹핑해서 하나의 대화로 묶기
  const grouped = new Map<string, ExperienceRow[]>();
  for (const row of rows) {
    const group = grouped.get(row.channel_id) ?? [];
    group.push(row);
    grouped.set(row.channel_id, group);
  }

  const conversations: ProjectConversation[] = [];

  for (const [channelId, channelRows] of grouped) {
    const messages: Message[] = channelRows.map((r) => ({
      role: "user" as const,
      text: r.calendar_event_title
        ? `[${r.calendar_event_title} 후기]\n${r.content}`
        : r.content,
      timestamp: r.created_at,
    }));

    conversations.push({
      projectName: `discord-experience-${channelId}`,
      messages,
    });
  }

  console.log(`✅ Discord 경험 ${rows.length}개 수집 (${conversations.length}개 채널)`);

  return {
    conversations,
    ids: rows.map((r) => r.id),
  };
}
