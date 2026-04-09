import { Client } from "@notionhq/client";
import type {
  PageObjectResponse,
  BlockObjectResponse,
  RichTextItemResponse,
} from "@notionhq/client/build/src/api-endpoints.js";
import { ProjectConversation, Message } from "./collect.js";

const notion = new Client({ auth: process.env.NOTION_API_KEY });

// 리치텍스트 → 일반 텍스트 변환
function richTextToPlain(richText: RichTextItemResponse[]): string {
  return richText.map((t) => t.plain_text).join("");
}

// 블록 → 마크다운 변환 (페이지네이션 처리)
async function blocksToMarkdown(blockId: string): Promise<string> {
  const lines: string[] = [];
  let cursor: string | undefined;

  do {
    const res = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;

    for (const block of res.results) {
      const b = block as BlockObjectResponse;

      switch (b.type) {
        case "paragraph":
          lines.push(richTextToPlain(b.paragraph.rich_text));
          break;
        case "heading_1":
          lines.push(`# ${richTextToPlain(b.heading_1.rich_text)}`);
          break;
        case "heading_2":
          lines.push(`## ${richTextToPlain(b.heading_2.rich_text)}`);
          break;
        case "heading_3":
          lines.push(`### ${richTextToPlain(b.heading_3.rich_text)}`);
          break;
        case "bulleted_list_item":
          lines.push(`- ${richTextToPlain(b.bulleted_list_item.rich_text)}`);
          break;
        case "numbered_list_item":
          lines.push(`1. ${richTextToPlain(b.numbered_list_item.rich_text)}`);
          break;
        case "code":
          lines.push(
            `\`\`\`${b.code.language}\n${richTextToPlain(b.code.rich_text)}\n\`\`\``,
          );
          break;
        case "quote":
          lines.push(`> ${richTextToPlain(b.quote.rich_text)}`);
          break;
        case "divider":
          lines.push("---");
          break;
        default:
          break;
      }
    }
  } while (cursor);

  return lines.filter((l) => l.trim()).join("\n\n");
}

// 페이지 제목 추출
function getPageTitle(page: PageObjectResponse): string {
  const props = page.properties;
  for (const key of Object.keys(props)) {
    const prop = props[key];
    if (prop.type === "title" && prop.title.length > 0) {
      return richTextToPlain(prop.title);
    }
  }
  return "제목 없음";
}

// 이번 주 날짜 범위
function getWeekRange(): { start: Date; end: Date } {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;

  const start = new Date(now);
  start.setDate(now.getDate() + diffToMonday);
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);

  return { start, end };
}

// 특정 페이지 ID 목록에서 내용 수집
async function collectFromPages(
  pageIds: string[],
): Promise<ProjectConversation[]> {
  const { start, end } = getWeekRange();
  const results: ProjectConversation[] = [];

  for (const pageId of pageIds) {
    try {
      const page = (await notion.pages.retrieve({
        page_id: pageId,
      })) as PageObjectResponse;
      const lastEdited = new Date(page.last_edited_time);

      // 이번 주 수정된 페이지만 수집
      if (lastEdited < start || lastEdited > end) {
        console.log(`⏭️  스킵 (이번 주 수정 아님): ${getPageTitle(page)}`);
        continue;
      }

      const title = getPageTitle(page);
      const content = await blocksToMarkdown(pageId);

      if (!content.trim()) continue;

      const message: Message = {
        role: "user",
        text: `[노션 페이지: ${title}]\n\n${content}`,
        timestamp: page.last_edited_time,
      };

      results.push({
        projectName: `notion-${title}`,
        messages: [message],
      });

      console.log(`✅ 노션 페이지 수집: ${title}`);
    } catch (err) {
      console.error(`❌ 페이지 ${pageId} 수집 실패:`, err);
    }
  }

  return results;
}

// 데이터베이스에서 이번 주 수정된 항목 수집
async function collectFromDatabase(
  databaseId: string,
): Promise<ProjectConversation[]> {
  const { start } = getWeekRange();
  const results: ProjectConversation[] = [];

  const res = (await (notion as any).request({
    path: `databases/${databaseId}/query`,
    method: "POST",
    body: {
      filter: {
        timestamp: "last_edited_time",
        last_edited_time: { on_or_after: start.toISOString() },
      },
    },
  })) as { results: PageObjectResponse[] };

  for (const page of res.results) {
    const p = page as PageObjectResponse;
    const title = getPageTitle(p);
    const content = await blocksToMarkdown(p.id);

    if (!content.trim()) continue;

    const message: Message = {
      role: "user",
      text: `[노션 DB 항목: ${title}]\n\n${content}`,
      timestamp: p.last_edited_time,
    };

    results.push({
      projectName: `notion-db-${title}`,
      messages: [message],
    });

    console.log(`✅ 노션 DB 항목 수집: ${title}`);
  }

  return results;
}

export async function collectNotionContent(): Promise<ProjectConversation[]> {
  if (!process.env.NOTION_API_KEY) {
    console.log("⏭️  NOTION_API_KEY 없음, 노션 수집 스킵");
    return [];
  }

  const results: ProjectConversation[] = [];

  // 개별 페이지 ID들 (콤마 구분)
  const pageIds =
    process.env.NOTION_PAGE_IDS?.split(",")
      .map((id) => id.trim())
      .filter(Boolean) ?? [];
  if (pageIds.length > 0) {
    console.log(`📄 노션 페이지 ${pageIds.length}개 수집 중...`);
    const pages = await collectFromPages(pageIds);
    results.push(...pages);
  }

  // 데이터베이스 ID들 (콤마 구분)
  const dbIds =
    process.env.NOTION_DATABASE_IDS?.split(",")
      .map((id) => id.trim())
      .filter(Boolean) ?? [];
  for (const dbId of dbIds) {
    console.log(`🗃️  노션 DB 수집 중...`);
    const items = await collectFromDatabase(dbId);
    results.push(...items);
  }

  return results;
}
