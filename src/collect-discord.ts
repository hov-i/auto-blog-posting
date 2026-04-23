import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const DISCORD_API = "https://discord.com/api/v10";

function discordHeaders() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN 없음");
  return { Authorization: `Bot ${token}`, "Content-Type": "application/json" };
}

interface DiscordMessage {
  id: string;
  content: string;
  author: { bot?: boolean };
  timestamp: string;
}

async function fetchThreadMessages(
  threadId: string,
  afterId?: string,
): Promise<DiscordMessage[]> {
  const params = new URLSearchParams({ limit: "100" });
  if (afterId) params.set("after", afterId);

  const res = await fetch(`${DISCORD_API}/channels/${threadId}/messages?${params}`, {
    headers: discordHeaders(),
  });

  if (!res.ok) throw new Error(`Discord API ${res.status}: ${await res.text()}`);
  return res.json() as Promise<DiscordMessage[]>;
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase 환경변수 없음");
  return createClient(url, key);
}

export async function syncDiscordExperiences(): Promise<void> {
  if (!process.env.DISCORD_BOT_TOKEN) {
    console.log("⏭️  DISCORD_BOT_TOKEN 없음, Discord 수집 스킵");
    return;
  }

  const supabase = getSupabase();

  // 생성된 모든 스레드 조회
  const { data: threads, error } = await supabase
    .from("experience_threads")
    .select("discord_thread_id, event_title");

  if (error) throw error;

  if (!threads || threads.length === 0) {
    console.log("⏭️  수집할 스레드 없음");
    return;
  }

  let totalSaved = 0;

  for (const thread of threads) {
    const threadId = thread.discord_thread_id as string;
    const eventTitle = thread.event_title as string;

    // 마지막으로 저장된 메시지 ID (중복 방지)
    const { data: lastSaved } = await supabase
      .from("experiences")
      .select("discord_message_id")
      .eq("channel_id", threadId)
      .order("created_at", { ascending: false })
      .limit(1);

    const afterId = lastSaved?.[0]?.discord_message_id as string | undefined;
    const messages = await fetchThreadMessages(threadId, afterId);

    // 봇 메시지 제외, 20자 이상 유저 메시지만
    const userMessages = messages.filter(
      (m) => !m.author.bot && m.content.trim().length > 20,
    );

    if (userMessages.length === 0) {
      console.log(`"${eventTitle}": 새 후기 없음`);
      continue;
    }

    const rows = userMessages.map((m) => ({
      discord_message_id: m.id,
      channel_id: threadId,
      content: m.content,
      calendar_event_title: eventTitle,
      created_at: m.timestamp,
      processed: false,
    }));

    const { error: insertError } = await supabase.from("experiences").upsert(rows, {
      onConflict: "discord_message_id",
      ignoreDuplicates: true,
    });

    if (insertError) {
      console.error(`❌ "${eventTitle}" 저장 실패:`, insertError.message);
    } else {
      console.log(`✅ "${eventTitle}": ${userMessages.length}개 후기 저장`);
      totalSaved += userMessages.length;
    }
  }

  console.log(`\n📦 총 ${totalSaved}개 후기 저장`);
}

if (
  process.argv[1]?.endsWith("collect-discord.ts") ||
  process.argv[1]?.endsWith("collect-discord.js")
) {
  syncDiscordExperiences().catch((err) => {
    console.error("💥 에러:", err);
    process.exit(1);
  });
}
