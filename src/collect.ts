import fs from "fs";
import path from "path";
import os from "os";

export interface Message {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
}

export interface ProjectConversation {
  projectName: string;
  messages: Message[];
}

function getClaudeProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

function getWeekRange(): { start: Date; end: Date } {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=일, 1=월, ..., 6=토
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;

  const start = new Date(now);
  start.setDate(now.getDate() + diffToMonday);
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);

  return { start, end };
}

export function parseJsonlFile(filePath: string): Message[] {
  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());

  const messages: Message[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type !== "user" && obj.type !== "assistant") continue;

      const content = obj.message?.content;
      if (!content) continue;

      let text = "";
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .filter((c: { type: string }) => c.type === "text")
          .map((c: { text: string }) => c.text)
          .join("\n");
      }

      if (!text.trim()) continue;

      messages.push({
        role: obj.type,
        text: text.trim(),
        timestamp: obj.timestamp ?? "",
      });
    } catch {
      // 파싱 실패한 줄은 스킵
    }
  }

  return messages;
}

function isInWeekRange(timestamp: string, start: Date, end: Date): boolean {
  if (!timestamp) return false;
  const date = new Date(timestamp);
  return date >= start && date <= end;
}

export function collectWeeklyLogs(): ProjectConversation[] {
  const projectsDir = getClaudeProjectsDir();
  const { start, end } = getWeekRange();

  console.log(`📅 수집 기간: ${start.toLocaleDateString()} ~ ${end.toLocaleDateString()}`);

  if (!fs.existsSync(projectsDir)) {
    console.error("❌ ~/.claude/projects 디렉토리를 찾을 수 없어요!");
    return [];
  }

  const projectDirs = fs.readdirSync(projectsDir).filter((name) => {
    const fullPath = path.join(projectsDir, name);
    return fs.statSync(fullPath).isDirectory();
  });

  const result: ProjectConversation[] = [];

  for (const projectDir of projectDirs) {
    const projectPath = path.join(projectsDir, projectDir);
    const jsonlFiles = fs
      .readdirSync(projectPath)
      .filter((f) => f.endsWith(".jsonl"));

    const allMessages: Message[] = [];

    for (const jsonlFile of jsonlFiles) {
      const filePath = path.join(projectPath, jsonlFile);
      const messages = parseJsonlFile(filePath);

      // 이번 주 메시지만 필터링
      const weeklyMessages = messages.filter((m) =>
        isInWeekRange(m.timestamp, start, end)
      );

      allMessages.push(...weeklyMessages);
    }

    if (allMessages.length > 0) {
      // 프로젝트 폴더명을 읽기 좋게 변환 (-Users-name-project → project)
      const parts = projectDir.split("-");
      const projectName = parts.slice(3).join("-") || projectDir;

      result.push({ projectName, messages: allMessages });
      console.log(`✅ ${projectName}: ${allMessages.length}개 메시지 수집`);
    }
  }

  console.log(`\n📦 총 ${result.length}개 프로젝트에서 대화 수집 완료!`);
  return result;
}

// 단독 실행 시 테스트
if (process.argv[1]?.endsWith("collect.ts") || process.argv[1]?.endsWith("collect.js")) {
  const logs = collectWeeklyLogs();
  console.log(JSON.stringify(logs, null, 2));
}
