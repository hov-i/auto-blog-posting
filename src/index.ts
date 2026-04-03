import "dotenv/config";
import { collectWeeklyLogs } from "./collect.js";
import { collectNotionContent } from "./collect-notion.js";
import { summarizeConversations } from "./summarize.js";
import { uploadDrafts } from "./upload-drafts.js";

async function main() {
  console.log("🚀 자동 블로그 포스팅 파이프라인 시작!\n");

  // 1단계: 로그 수집
  console.log("=== 1단계: 클로드 코드 로그 수집 ===");
  const claudeLogs = collectWeeklyLogs();

  console.log("\n=== 1-2단계: 노션 내용 수집 ===");
  const notionLogs = await collectNotionContent();

  const conversations = [...claudeLogs, ...notionLogs];

  if (conversations.length === 0) {
    console.log("이번 주 수집된 대화가 없어서 종료할게요!");
    return;
  }

  // 2단계: Claude API로 요약 + 말투 학습
  console.log("\n=== 2단계: 블로그 초안 생성 ===");
  const drafts = await summarizeConversations(conversations);

  if (drafts.length === 0) {
    console.log("생성된 초안이 없어서 종료할게요!");
    return;
  }

  // 3단계: Supabase에 draft 저장
  console.log("\n=== 3단계: 초안 저장 ===");
  await uploadDrafts(drafts);

  console.log("\n✨ 파이프라인 완료! 블로그에서 /admin/drafts 확인해봐~");
}

main().catch((err) => {
  console.error("💥 파이프라인 에러:", err);
  process.exit(1);
});
