import "dotenv/config";
import fs from "fs";
import path from "path";
import os from "os";
import { createClient } from "@supabase/supabase-js";
import { parseJsonlFile } from "./collect.js";

const MIN_MESSAGES = 5; // 너무 짧은 대화 스킵

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL 또는 KEY가 없어요!");
  return createClient(url, key);
}

function getAllConversationFiles() {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(projectsDir)) return [];

  const result: { projectName: string; filePath: string; fileKey: string }[] = [];

  const projectDirs = fs
    .readdirSync(projectsDir)
    .filter((name) => fs.statSync(path.join(projectsDir, name)).isDirectory());

  for (const projectDir of projectDirs) {
    const parts = projectDir.split("-");
    const projectName = parts.slice(3).join("-") || projectDir;
    const projectPath = path.join(projectsDir, projectDir);
    const jsonlFiles = fs.readdirSync(projectPath).filter((f) => f.endsWith(".jsonl"));

    for (const file of jsonlFiles) {
      result.push({
        projectName,
        filePath: path.join(projectPath, file),
        fileKey: `${projectDir}/${file}`,
      });
    }
  }

  return result;
}

async function main() {
  console.log("🔄 Claude 로그 Supabase 동기화 시작...");

  const supabase = getSupabaseClient();
  const files = getAllConversationFiles();

  if (files.length === 0) {
    console.log("Claude 프로젝트 파일 없음");
    return;
  }

  // 기존 동기화 파일의 file_key + 메시지 수 조회
  const { data: existing } = await supabase
    .from("conversations")
    .select("file_key, messages")
    .eq("source", "claude");

  // file_key → 저장된 메시지 수 맵
  const syncedMap = new Map<string, number>(
    (existing ?? []).map((r) => [
      r.file_key as string,
      Array.isArray(r.messages) ? (r.messages as unknown[]).length : 0,
    ])
  );

  let synced = 0;
  let updated = 0;
  let skipped = 0;

  for (const { projectName, filePath, fileKey } of files) {
    const messages = parseJsonlFile(filePath);
    const storedCount = syncedMap.get(fileKey);

    if (storedCount !== undefined) {
      // 이미 있는 파일 — 메시지 수 비교해서 증가했으면 업데이트
      if (messages.length <= storedCount) {
        skipped++;
        continue;
      }

      const { error } = await supabase
        .from("conversations")
        .update({ messages, processed: false })
        .eq("file_key", fileKey)
        .eq("source", "claude");

      if (error) {
        console.error(`❌ ${fileKey} 업데이트 실패:`, error.message);
      } else {
        console.log(`🔄 ${projectName} 업데이트 (${storedCount} → ${messages.length}개 메시지)`);
        updated++;
      }
      continue;
    }

    // 새 파일 — 최소 메시지 수 체크 후 INSERT
    if (messages.length < MIN_MESSAGES) {
      skipped++;
      continue;
    }

    const { error } = await supabase.from("conversations").insert({
      project_name: projectName,
      file_key: fileKey,
      messages,
      source: "claude",
      processed: false,
    });

    if (error) {
      console.error(`❌ ${fileKey} 저장 실패:`, error.message);
    } else {
      console.log(`✅ ${projectName} (${messages.length}개 메시지)`);
      synced++;
    }
  }

  console.log(`\n📦 ${synced}개 새로 동기화, ${updated}개 업데이트, ${skipped}개 스킵`);
}

main().catch((err) => {
  console.error("💥 sync 에러:", err);
  process.exit(1);
});
