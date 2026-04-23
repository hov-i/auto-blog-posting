// =============================================
// 설정값 (여기만 바꿔줘~)
// =============================================
const GITHUB_TOKEN = "여기에_GITHUB_TOKEN";
const GITHUB_REPO = "여기에_유저명/레포명"; // 예: hov-i/auto-blog-posting
const BLOG_CALENDAR_ID = "여기에_캘린더ID";

// =============================================
// 1. 캘린더 일정 생성/수정 시 실행
//    → 종료 시간에 알림 트리거 예약
// =============================================
function onCalendarEventCreated() {
  const calendar = CalendarApp.getCalendarById(BLOG_CALENDAR_ID);
  const now = new Date();
  const future = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const events = calendar.getEvents(now, future);
  const props = PropertiesService.getScriptProperties();

  for (const event of events) {
    const eventKey = `event_${event.getId()}`;
    const endTime = event.getEndTime();

    if (endTime <= now) continue;

    const existing = props.getProperty(eventKey);
    const existingData = existing ? JSON.parse(existing) : null;

    // 이미 등록됐고 종료 시간도 안 바뀌었으면 스킵
    if (existingData && !existingData.sent && existingData.endTime === endTime.getTime()) continue;

    // 시간이 수정된 경우 기존 트리거 삭제
    if (existingData) {
      ScriptApp.getProjectTriggers()
        .filter(t => t.getHandlerFunction() === "sendDiscordThread")
        .forEach(t => ScriptApp.deleteTrigger(t));
    }

    props.setProperty(
      eventKey,
      JSON.stringify({
        title: event.getTitle(),
        endTime: endTime.getTime(),
        sent: false,
      })
    );

    ScriptApp.newTrigger("sendDiscordThread").timeBased().at(endTime).create();
    console.log(`✅ 트리거 예약: "${event.getTitle()}" → ${endTime}`);
  }
}

// =============================================
// 2. 종료 시간 도달 시 실행
//    → GitHub Actions 트리거 (Discord IP 차단 우회)
// =============================================
function sendDiscordThread() {
  const props = PropertiesService.getScriptProperties();
  const allProps = props.getProperties();
  const now = new Date().getTime();

  for (const [key, value] of Object.entries(allProps)) {
    if (!key.startsWith("event_")) continue;

    const data = JSON.parse(value);
    if (data.sent || data.endTime > now) continue;

    triggerGithubActions(data.title);

    data.sent = true;
    props.setProperty(key, JSON.stringify(data));
    console.log(`📬 GitHub Actions 트리거: "${data.title}"`);
  }

  cleanupTriggers();
}

// =============================================
// GitHub Actions repository_dispatch 호출
// =============================================
function triggerGithubActions(title) {
  const res = UrlFetchApp.fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/dispatches`,
    {
      method: "post",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github.v3+json",
      },
      payload: JSON.stringify({
        event_type: "calendar-event-ended",
        client_payload: { title },
      }),
      muteHttpExceptions: true,
    }
  );

  if (res.getResponseCode() !== 204) {
    console.error("GitHub Actions 트리거 실패:", res.getContentText());
  }
}

// =============================================
// 완료된 트리거 정리
// =============================================
function cleanupTriggers() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === "sendDiscordThread")
    .forEach(t => ScriptApp.deleteTrigger(t));
}
