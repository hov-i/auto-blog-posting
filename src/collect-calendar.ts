import "dotenv/config";
import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";

const DISCORD_API = "https://discord.com/api/v10";
const CHECK_WINDOW_HOURS = 1; // 매시간 cron 실행이므로 1시간 윈도우

function discordHeaders() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN 없음");
  return { Authorization: `Bot ${token}`, "Content-Type": "application/json" };
}

function getAuth() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error("Google OAuth 환경변수 없음");
  }
  const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return auth;
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase 환경변수 없음");
  return createClient(url, key);
}

async function createEventThread(channelId: string, eventTitle: string): Promise<string> {
  // 1. 채널에 알림 메시지 보내기
  const msgRes = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: discordHeaders(),
    body: JSON.stringify({
      content:
        `🗓️ **"${eventTitle}"** 일정이 끝났어~!\n` +
        `아래 스레드에 후기 남겨줘! 블로그 글로 만들어줄게 😎`,
    }),
  });
  if (!msgRes.ok) throw new Error(`메시지 전송 실패: ${msgRes.status} ${await msgRes.text()}`);
  const msg = (await msgRes.json()) as { id: string };

  // 2. 그 메시지에 스레드 생성
  const threadRes = await fetch(
    `${DISCORD_API}/channels/${channelId}/messages/${msg.id}/threads`,
    {
      method: "POST",
      headers: discordHeaders(),
      body: JSON.stringify({
        name: `${eventTitle} 후기`,
        auto_archive_duration: 10080, // 7일
      }),
    },
  );
  if (!threadRes.ok)
    throw new Error(`스레드 생성 실패: ${threadRes.status} ${await threadRes.text()}`);
  const thread = (await threadRes.json()) as { id: string };

  return thread.id;
}

export async function checkCalendarAndNotify(): Promise<void> {
  if (!process.env.GOOGLE_CLIENT_ID) {
    console.log("⏭️  Google OAuth 환경변수 없음, 캘린더 체크 스킵");
    return;
  }

  const channelId = process.env.DISCORD_EXPERIENCE_CHANNEL_IDS?.split(",")[0]?.trim();
  if (!channelId) {
    console.log("⏭️  DISCORD_EXPERIENCE_CHANNEL_IDS 없음, 스킵");
    return;
  }

  const auth = getAuth();
  const calendar = google.calendar({ version: "v3", auth });
  const supabase = getSupabase();

  const calendarId = process.env.GOOGLE_CALENDAR_ID ?? "primary";
  const now = new Date();
  const timeMin = new Date(now.getTime() - CHECK_WINDOW_HOURS * 60 * 60 * 1000);

  const res = await calendar.events.list({
    calendarId,
    timeMin: timeMin.toISOString(),
    timeMax: now.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });

  const events = res.data.items ?? [];

  const endedEvents = events.filter((e) => {
    const end = e.end?.dateTime ?? e.end?.date;
    if (!end) return false;
    const endDate = new Date(end);
    return endDate <= now && endDate >= timeMin;
  });

  if (endedEvents.length === 0) {
    console.log("최근 종료된 일정 없음");
    return;
  }

  for (const event of endedEvents) {
    const title = event.summary ?? "제목 없음";
    const eventId = event.id ?? title;

    // 이미 스레드 생성된 이벤트인지 체크 (중복 방지)
    const { data: existing } = await supabase
      .from("experience_threads")
      .select("id")
      .eq("calendar_event_id", eventId)
      .limit(1);

    if (existing && existing.length > 0) {
      console.log(`⏭️  이미 스레드 있음: "${title}"`);
      continue;
    }

    console.log(`📅 감지: "${title}" → 스레드 생성 중...`);
    const threadId = await createEventThread(channelId, title);

    await supabase.from("experience_threads").insert({
      event_title: title,
      calendar_event_id: eventId,
      discord_thread_id: threadId,
      discord_channel_id: channelId,
    });

    console.log(`✅ 스레드 생성 완료: "${title}"`);
  }
}

if (
  process.argv[1]?.endsWith("collect-calendar.ts") ||
  process.argv[1]?.endsWith("collect-calendar.js")
) {
  checkCalendarAndNotify().catch((err) => {
    console.error("💥 에러:", err);
    process.exit(1);
  });
}
