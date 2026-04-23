import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const DISCORD_API = "https://discord.com/api/v10";

function discordHeaders() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN 없음");
  return { Authorization: `Bot ${token}`, "Content-Type": "application/json" };
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase 환경변수 없음");
  return createClient(url, key);
}

async function main() {
  const title = process.env.EVENT_TITLE;
  if (!title) throw new Error("EVENT_TITLE 없음");

  const channelId = process.env.DISCORD_EXPERIENCE_CHANNEL_IDS?.split(",")[0]?.trim();
  if (!channelId) throw new Error("DISCORD_EXPERIENCE_CHANNEL_IDS 없음");

  // 1. 채널에 메시지 보내기
  const msgRes = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: discordHeaders(),
    body: JSON.stringify({
      content: `🗓️ **"${title}"** 일정이 끝났어~!\n후기를 이 스레드에 남겨줘! 블로그 글로 만들어줄게 😎`,
    }),
  });

  if (!msgRes.ok) throw new Error(`메시지 전송 실패: ${msgRes.status} ${await msgRes.text()}`);
  const msg = (await msgRes.json()) as { id: string };

  // 2. 스레드 생성
  const threadRes = await fetch(
    `${DISCORD_API}/channels/${channelId}/messages/${msg.id}/threads`,
    {
      method: "POST",
      headers: discordHeaders(),
      body: JSON.stringify({
        name: `${title} 후기`,
        auto_archive_duration: 10080,
      }),
    },
  );

  if (!threadRes.ok) throw new Error(`스레드 생성 실패: ${threadRes.status} ${await threadRes.text()}`);
  const thread = (await threadRes.json()) as { id: string };

  // 3. Supabase experience_threads에 저장 (collect-discord가 수집할 수 있도록)
  const supabase = getSupabase();
  const { error } = await supabase.from("experience_threads").upsert(
    {
      event_title: title,
      calendar_event_id: `${title}_${Date.now()}`,
      discord_thread_id: thread.id,
      discord_channel_id: channelId,
    },
    { onConflict: "discord_thread_id", ignoreDuplicates: true },
  );

  if (error) throw new Error(`experience_threads 저장 실패: ${error.message}`);

  console.log(`✅ Discord 스레드 생성 완료: "${title}" (${thread.id})`);
}

main().catch((err) => {
  console.error("💥 에러:", err);
  process.exit(1);
});
