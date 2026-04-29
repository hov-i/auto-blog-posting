import Anthropic from "@anthropic-ai/sdk";
import { ProjectConversation } from "./collect.js";

export interface DraftPost {
  title: string;
  description: string;
  content: string;
  tags: string[];
  sourceProject: string;
  conversation?: ProjectConversation;
}

export interface Insight {
  topic: string;
  summary: string;
  techStack: string[];
  sourceProject: string;
  excerpt: string; // 대화에서 뽑은 핵심 발췌
  _conversation?: ProjectConversation; // 내부 참조용 (API에 안 보냄)
}

interface InsightCluster {
  theme: string;
  angle: string; // 어떤 방향의 글로 쓸지
  insights: Insight[];
  qualityScore: number; // 1-5, 3 미만이면 생성 스킵
}

// 영속화된 인사이트 (topic_clusters.insights JSONB 안에 저장되는 형태)
export interface StoredInsight {
  topic: string;
  summary: string;
  techStack: string[];
  sourceProject: string;
  excerpt: string;
}

// topic_clusters DB row
export interface PendingClusterRow {
  id: number;
  theme: string;
  angle: string | null;
  quality_score: number;
  insights: StoredInsight[];
  source_projects: string[];
  tech_stack: string[];
  last_updated_at: string;
}

export interface MergeResult {
  existingUpdates: Map<number, Insight[]>; // clusterId -> 새로 합쳐진 인사이트들
  newClusters: {
    theme: string;
    angle: string;
    qualityScore: number;
    techStack: string[];
    insights: Insight[];
  }[];
}

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const BLOG_STYLE_TEMPLATE = `
## 블로그 글쓰기 스타일 가이드

### 공통 말투 & 톤
- 1인칭 경험담 중심 ("나는 ~했다", "~게 느꼈다", "~인 줄 알았는데")
- 딱딱하지 않고 솔직하게, 감정 자연스럽게 표현
- "사실 ~라는 단점이 있었는데", "생각보다 ~해서 감동 받았다..", "~게 마음에 들었다" 같은 표현 자주 사용
- 과도한 기술 용어 나열 금지, 맥락과 함께 설명

---

### 글 유형 1: 경험/회고 글 (프로젝트, 협업, 이벤트 참여 후기)

구조:
1. 맨 첫 줄: > 블록쿼트로 이 글을 쓰게 된 계기/맥락 1~2문장
2. 빈 줄 하나 띄운 뒤 ## 헤더로 섹션 구분
3. 기술 선택은 "왜 선택했는지", "어떤 점이 좋았는지" 위주로 풀어서 설명
4. 이슈/문제는 솔직하게 언급 후 어떻게 해결했는지 공유
5. 마지막: 회고 또는 앞으로의 계획으로 마무리 (희망적인 톤)

---

### 글 유형 2: 기술 학습 정리 글 (개념 공부, 라이브러리 분석, 트러블슈팅)

구조:
1. 맨 첫 줄: > 블록쿼트로 이 글을 쓰게 된 상황 설명
2. 빈 줄 하나 띄운 뒤 # 헤더로 첫 번째 섹션 시작
3. 글의 흐름은 "개념 소개 → 상세 설명 → 비교/분석 → 결론" 순서로
4. 코드 예시는 언어 명시한 코드블록으로
5. 마지막 섹션은 반드시 # 마치며
6. 참고 URL 있으면 #### Reference 추가

---

### 글 유형 선택 기준
- 프로젝트 경험, 협업, 이벤트, 회고 → 유형 1
- 개념 공부, 라이브러리 비교, 에러 해결, 기술 분석 → 유형 2
`;

// 노이즈 제거 + 길이 압축
function cleanConversationText(conversation: ProjectConversation): string {
  const cleaned = conversation.messages
    .filter((m) => m.text.length > 20)
    .map((m) => {
      let text = m.text;

      // 500자 이상 코드블록 압축 (블록 단위로 각각 처리)
      text = text.replace(
        /```(\w*)\n([\s\S]*?)```/g,
        (match, lang, content) => {
          if (content.length < 500) return match;
          return `\`\`\`${lang}\n[코드 블록 생략]\n\`\`\``;
        },
      );

      if (text.length > 2000) {
        text = text.slice(0, 1500) + "\n...(생략)";
      }

      return `[${m.role === "user" ? "나" : "AI"}] ${text}`;
    });

  const MAX = 40;
  const selected =
    cleaned.length > MAX
      ? Array.from({ length: MAX }, (_, i) => {
          const idx = Math.round((i / (MAX - 1)) * (cleaned.length - 1));
          return cleaned[idx];
        })
      : cleaned;

  return selected.join("\n\n");
}

// 1단계: 대화에서 인사이트 추출 (haiku, 병렬)
async function extractInsights(
  conversation: ProjectConversation,
): Promise<Insight[]> {
  const text = cleanConversationText(conversation);

  const res = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2000,
    tools: [
      {
        name: "extract_insights",
        description: "대화에서 블로그 가치가 있는 인사이트를 추출한다",
        input_schema: {
          type: "object" as const,
          properties: {
            insights: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  topic: {
                    type: "string",
                    description:
                      "인사이트 주제 (e.g. React 상태관리, TypeScript 타입 추론)",
                  },
                  summary: { type: "string", description: "핵심 내용 2~3문장" },
                  techStack: {
                    type: "array",
                    items: { type: "string" },
                    description: "관련 기술 스택",
                  },
                  excerpt: {
                    type: "string",
                    description: "대화에서 가장 핵심적인 발췌 1~2문장",
                  },
                },
                required: ["topic", "summary", "techStack", "excerpt"],
              },
            },
          },
          required: ["insights"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "extract_insights" },
    messages: [
      {
        role: "user",
        content: `"${conversation.projectName}" 에서 블로그에 쓸 인사이트를 추출해.

**읽기 전 전처리**: ANSI 코드, 프로그레스 바, 파일 목록(ls/find 결과), 반복 빌드 로그는 노이즈로 간주하고 무시해.

**추출 가치 판단** — 아래 중 하나라도 해당하면 인사이트 추출:

[기술 대화 기준]
- 실질 대화 10턴 이상 (짧은 문답은 제외)
- 시도 → 실패 → 해결로 이어지는 문제 해결 과정
- 다른 개발자에게도 쓸모 있는 개념/판단/비교

[경험 후기 기준] (discord-experience 소스인 경우)
- 직접 방문/참여한 장소·이벤트·컨퍼런스에 대한 구체적인 묘사
- 개발 문화, 팀 구성, 기술 스택 등 개발자 관점의 인사이트
- 다른 개발자에게 참고가 될 경험 (오피스 투어, 세미나, 해커톤 등)
- 분량이 짧아도 구체적인 내용이 있으면 가치 있음

**인사이트 기준** (위 조건 충족 시):
- 포함: 기술 개념 학습, 설계 결정 이유, 트러블슈팅, 라이브러리 비교, 현장 경험 후기
- 제외: 오타·설정값·자잘한 버그 수정, "좋았다" 한 줄처럼 내용이 없는 것

대화:
---
${text}
---`,
      },
    ],
  });

  const toolUse = res.content.find((c) => c.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") return [];

  const input = toolUse.input as { insights: Omit<Insight, "sourceProject">[] };
  return (input.insights ?? []).map((i) => ({
    ...i,
    sourceProject: conversation.projectName,
    _conversation: conversation,
  }));
}

// 2단계: 전체 인사이트를 주제별로 클러스터링 (sonnet, 1회)
async function clusterInsights(
  insights: Insight[],
  existingTopics: string[] = [],
): Promise<InsightCluster[]> {
  const insightList = insights
    .map(
      (i, idx) =>
        `[${idx}] 프로젝트: ${i.sourceProject}\n주제: ${i.topic}\n요약: ${i.summary}\n발췌: ${i.excerpt}`,
    )
    .join("\n\n");

  const dedupSection =
    existingTopics.length > 0
      ? `\n이미 작성된 글 주제 (90% 이상 겹치면 클러스터 제외):\n${existingTopics.map((t) => `- ${t}`).join("\n")}\n`
      : "";

  const res = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    tools: [
      {
        name: "cluster_insights",
        description: "인사이트들을 블로그 글 주제 단위로 클러스터링한다",
        input_schema: {
          type: "object" as const,
          properties: {
            clusters: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  theme: {
                    type: "string",
                    description: "클러스터 주제 (블로그 글 제목 방향)",
                  },
                  angle: {
                    type: "string",
                    description:
                      "어떤 관점/구성으로 글을 쓸지 (e.g. 트러블슈팅 경험, 개념 비교, 구현 회고)",
                  },
                  insightIndexes: {
                    type: "array",
                    items: { type: "number" },
                    description: "이 클러스터에 포함되는 인사이트 인덱스 목록",
                  },
                  qualityScore: {
                    type: "number",
                    description: "블로그 글 가치 점수 1-5. 5=매우 깊고 유익한 글, 3=보통, 1=너무 얕거나 일반적인 내용",
                  },
                },
                required: ["theme", "angle", "insightIndexes", "qualityScore"],
              },
            },
          },
          required: ["clusters"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "cluster_insights" },
    messages: [
      {
        role: "user",
        content: `아래는 이번 주 개발 대화에서 추출한 인사이트 목록이야.
비슷한 주제끼리 묶어서 블로그 글 단위로 클러스터링해줘.
${dedupSection}
규칙:
- 하나의 클러스터 = 하나의 블로그 글
- 너무 비슷한 건 합치고, 관련 없는 건 분리
- 인사이트가 1개뿐인 클러스터도 괜찮음
- 블로그 글로 쓰기 너무 얕은 건 클러스터에서 제외

인사이트 목록:
${insightList}`,
      },
    ],
  });

  const toolUse = res.content.find((c) => c.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") return [];

  const input = toolUse.input as {
    clusters: { theme: string; angle: string; insightIndexes: number[]; qualityScore: number }[];
  };

  return (input.clusters ?? [])
    .map((c) => ({
      theme: c.theme,
      angle: c.angle,
      qualityScore: c.qualityScore ?? 3,
      insights: c.insightIndexes.map((i) => insights[i]).filter(Boolean),
    }))
    .filter((c) => c.insights.length > 0); // 빈 클러스터 제거
}

// 3단계: 클러스터 → 블로그 글 생성 (sonnet, 병렬)
async function generateFromCluster(
  cluster: InsightCluster,
): Promise<DraftPost | null> {
  const insightText = cluster.insights
    .map(
      (i) =>
        `[${i.sourceProject}]\n주제: ${i.topic}\n내용: ${i.summary}\n발췌: ${i.excerpt}\n기술스택: ${i.techStack.join(", ")}`,
    )
    .join("\n\n---\n\n");

  const res = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8000,
    tools: [
      {
        name: "create_blog_post",
        description: "인사이트 클러스터로 블로그 포스트를 생성한다",
        input_schema: {
          type: "object" as const,
          properties: {
            title: { type: "string", description: "블로그 글 제목" },
            description: {
              type: "string",
              description: "한 줄 요약 (미리보기용)",
            },
            content: { type: "string", description: "마크다운 본문 전체" },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "태그 목록",
            },
          },
          required: ["title", "description", "content", "tags"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "create_blog_post" },
    messages: [
      {
        role: "user",
        content: `아래 인사이트들을 합쳐서 블로그 글 하나를 작성해줘.

주제: ${cluster.theme}
글쓰기 방향: ${cluster.angle}

${BLOG_STYLE_TEMPLATE}

⚠️ content 작성 규칙:
- 첫 줄은 반드시 "> " blockquote로 시작 (이 글을 쓰게 된 계기/동기)
- 그 다음 빈 줄 하나 띄운 뒤 본문 시작
- 기술 학습 글: # 헤더, 경험/회고 글: ## 헤더

인사이트:
---
${insightText}
---`,
      },
    ],
  });

  const toolUse = res.content.find((c) => c.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") return null;

  const input = toolUse.input as Omit<
    DraftPost,
    "sourceProject" | "conversation"
  >;
  const sourceProjects = [
    ...new Set(cluster.insights.map((i) => i.sourceProject)),
  ];

  // 클러스터에 포함된 원본 대화들을 하나로 합쳐서 재생성 시 사용
  const sourceConversations = cluster.insights
    .map((i) => i._conversation)
    .filter((c): c is ProjectConversation => !!c);
  const uniqueConversations = sourceConversations.filter(
    (c, idx, arr) =>
      arr.findIndex((x) => x.projectName === c.projectName) === idx,
  );
  const mergedConversation: ProjectConversation | undefined =
    uniqueConversations.length > 0
      ? {
          projectName: sourceProjects.join(", "),
          messages: uniqueConversations.flatMap((c) => c.messages),
        }
      : undefined;

  return {
    ...input,
    sourceProject: sourceProjects.join(", "),
    conversation: mergedConversation,
  };
}

// API rate limit 방어: 최대 N개씩 배치 처리
async function runInBatches<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(
      batch.map((item, j) => fn(item, i + j)),
    );
    results.push(...batchResults);
  }
  return results;
}

// 경험 후기 전용 블로그 생성 (필터링 없이 바로 생성)
async function generateFromExperience(
  conversation: ProjectConversation,
): Promise<DraftPost | null> {
  const text = conversation.messages.map((m) => m.text).join("\n\n");

  const res = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8000,
    tools: [
      {
        name: "create_blog_post",
        description: "경험 후기를 블로그 포스트로 생성한다",
        input_schema: {
          type: "object" as const,
          properties: {
            title: { type: "string", description: "블로그 글 제목" },
            description: { type: "string", description: "한 줄 요약 (미리보기용)" },
            content: { type: "string", description: "마크다운 본문 전체" },
            tags: { type: "array", items: { type: "string" }, description: "태그 목록" },
          },
          required: ["title", "description", "content", "tags"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "create_blog_post" },
    messages: [
      {
        role: "user",
        content: `아래는 내가 직접 경험하고 남긴 후기야. 이걸 블로그 글로 만들어줘.

${BLOG_STYLE_TEMPLATE}

⚠️ content 작성 규칙:
- 첫 줄은 반드시 "> " blockquote로 시작 (이 글을 쓰게 된 계기/동기)
- 경험/회고 글 유형으로 작성 (## 헤더 사용)
- 1인칭 경험담으로, 솔직하고 구체적으로

후기 내용:
---
${text}
---`,
      },
    ],
  });

  const toolUse = res.content.find((c) => c.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") return null;

  const input = toolUse.input as Omit<DraftPost, "sourceProject" | "conversation">;
  return { ...input, sourceProject: conversation.projectName, conversation };
}

export async function summarizeConversations(
  conversations: ProjectConversation[],
  existingTopics: string[] = [],
): Promise<DraftPost[]> {
  if (conversations.length === 0) {
    console.log("📭 이번 주 수집된 대화가 없어요!");
    return [];
  }

  // 경험 후기 / 기술 대화 분리
  const experienceConvs = conversations.filter((c) =>
    c.projectName.startsWith("discord-experience-"),
  );
  const techConvs = conversations.filter(
    (c) => !c.projectName.startsWith("discord-experience-"),
  );

  const allDrafts: DraftPost[] = [];

  // 경험 후기 → 필터링 없이 바로 블로그 생성
  if (experienceConvs.length > 0) {
    console.log(`\n🌟 경험 후기 ${experienceConvs.length}개 블로그 생성 중...`);
    const expResults = await runInBatches(experienceConvs, 3, async (conv) => {
      const post = await generateFromExperience(conv);
      if (post) console.log(`  ✅ "${post.title}" 생성 완료`);
      return post;
    });
    for (const result of expResults) {
      if (result.status === "fulfilled" && result.value) {
        allDrafts.push(result.value);
      }
    }
  }

  if (techConvs.length === 0) {
    console.log(`\n🎉 총 ${allDrafts.length}개 블로그 초안 생성 완료!`);
    return allDrafts;
  }

  // 1단계: 기술 대화에서 인사이트 병렬 추출 (최대 5개 동시)
  console.log(
    `\n🔍 1단계: ${techConvs.length}개 기술 대화에서 인사이트 추출 중...`,
  );
  const insightResults = await runInBatches(techConvs, 5, async (conv) => {
    const insights = await extractInsights(conv);
    console.log(`  ✅ "${conv.projectName}" → ${insights.length}개 인사이트`);
    return insights;
  });

  const allInsights: Insight[] = [];
  for (let i = 0; i < insightResults.length; i++) {
    const result = insightResults[i];
    if (result.status === "fulfilled") {
      allInsights.push(...result.value);
    } else {
      console.error(
        `  ❌ "${conversations[i].projectName}" 인사이트 추출 실패:`,
        result.reason,
      );
    }
  }

  if (allInsights.length === 0) {
    console.log("💡 블로그 가치 있는 인사이트가 없어요!");
    return [];
  }

  console.log(`\n📦 총 ${allInsights.length}개 인사이트 수집 완료`);

  // 2단계: 클러스터링
  console.log(`\n🧩 2단계: 주제별 클러스터링 중...`);
  const clusters = await clusterInsights(allInsights, existingTopics);
  console.log(`  ✅ ${clusters.length}개 클러스터 생성`);
  clusters.forEach((c) =>
    console.log(`  - "${c.theme}" (인사이트 ${c.insights.length}개, 품질 ${c.qualityScore}/5)`),
  );

  // 점수 3 미만 클러스터 필터링
  const MIN_QUALITY = 3;
  const qualifiedClusters = clusters.filter((c) => c.qualityScore >= MIN_QUALITY);
  const skipped = clusters.length - qualifiedClusters.length;
  if (skipped > 0) {
    console.log(`  ⏭️  ${skipped}개 클러스터 스킵 (품질 점수 ${MIN_QUALITY} 미만)`);
  }

  if (qualifiedClusters.length === 0) {
    console.log("💡 품질 기준 통과한 클러스터가 없어요!");
    return [];
  }

  // 3단계: 클러스터별 블로그 글 생성 (최대 3개 동시, Sonnet 비용 절감)
  console.log(`\n✍️  3단계: ${qualifiedClusters.length}개 블로그 글 생성 중...`);
  const postResults = await runInBatches(qualifiedClusters, 3, async (cluster) => {
    const post = await generateFromCluster(cluster);
    if (post) console.log(`  ✅ "${post.title}" 생성 완료`);
    return post;
  });

  for (const result of postResults) {
    if (result.status === "fulfilled" && result.value) {
      allDrafts.push(result.value);
    }
  }

  console.log(`\n🎉 총 ${allDrafts.length}개 블로그 초안 생성 완료!`);
  return allDrafts;
}

// 단일 대화 재생성용 (generate.ts에서 사용)
export async function generateDraftPosts(
  conversation: ProjectConversation,
): Promise<DraftPost[]> {
  const insights = await extractInsights(conversation);
  if (insights.length === 0) return [];

  const clusters = await clusterInsights(insights);
  const postResults = await Promise.allSettled(
    clusters.map((cluster) => generateFromCluster(cluster)),
  );

  return postResults
    .filter(
      (r): r is PromiseFulfilledResult<DraftPost> =>
        r.status === "fulfilled" && r.value !== null,
    )
    .map((r) => ({ ...r.value, conversation }));
}

// =============================================
// 누적 클러스터링 (topic_clusters 테이블 기반)
// =============================================

// 기술 대화들에서 인사이트만 병렬 추출 (클러스터링 분리)
export async function extractInsightsFromTechConversations(
  conversations: ProjectConversation[],
): Promise<Insight[]> {
  if (conversations.length === 0) return [];

  console.log(
    `\n🔍 ${conversations.length}개 기술 대화에서 인사이트 추출 중...`,
  );
  const results = await runInBatches(conversations, 5, async (conv) => {
    const insights = await extractInsights(conv);
    console.log(`  ✅ "${conv.projectName}" → ${insights.length}개 인사이트`);
    return insights;
  });

  const all: Insight[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") all.push(...r.value);
    else
      console.error(
        `  ❌ "${conversations[i].projectName}" 인사이트 추출 실패:`,
        r.reason,
      );
  }
  return all;
}

// 1차 후보 필터: 새 인사이트와 techStack 교집합 큰 클러스터 top-K
export function prefilterPendingClusters(
  newInsights: Insight[],
  pending: PendingClusterRow[],
  topK = 8,
): PendingClusterRow[] {
  if (pending.length <= topK) return pending;

  const newTechs = new Set(
    newInsights.flatMap((i) => i.techStack.map((t) => t.toLowerCase())),
  );

  const scored = pending.map((c) => {
    const techs = (c.tech_stack ?? []).map((t) => t.toLowerCase());
    let overlap = 0;
    for (const t of techs) if (newTechs.has(t)) overlap++;
    return { c, overlap };
  });

  scored.sort((a, b) => {
    if (b.overlap !== a.overlap) return b.overlap - a.overlap;
    // tie-break: 더 최근에 업데이트된 것 우선
    return (b.c.last_updated_at ?? "").localeCompare(a.c.last_updated_at ?? "");
  });

  return scored.slice(0, topK).map((s) => s.c);
}

// 새 인사이트들을 기존 pending 클러스터에 합치거나 새 클러스터로 묶음 (Sonnet 1회)
export async function mergeInsightsIntoClusters(
  newInsights: Insight[],
  candidates: PendingClusterRow[],
): Promise<MergeResult> {
  const empty: MergeResult = { existingUpdates: new Map(), newClusters: [] };
  if (newInsights.length === 0) return empty;

  const insightList = newInsights
    .map(
      (ins, i) =>
        `[N${i}] 프로젝트: ${ins.sourceProject}\n주제: ${ins.topic}\n요약: ${ins.summary}\n기술스택: ${ins.techStack.join(", ")}\n발췌: ${ins.excerpt}`,
    )
    .join("\n\n");

  const candidateList =
    candidates.length === 0
      ? "(기존 pending 클러스터 없음 — 모두 새 클러스터로)"
      : candidates
          .map(
            (c) =>
              `[E${c.id}] 주제: ${c.theme}\n방향: ${c.angle ?? "-"}\n기술스택: ${(c.tech_stack ?? []).join(", ")}\n포함 인사이트: ${c.insights.length}개`,
          )
          .join("\n\n");

  const res = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 3000,
    tools: [
      {
        name: "route_insights",
        description:
          "각 새 인사이트를 기존 클러스터에 합치거나 새 클러스터로 묶는다",
        input_schema: {
          type: "object" as const,
          properties: {
            decisions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  new_insight_index: { type: "number" },
                  target_existing_cluster_id: {
                    type: "number",
                    description:
                      "기존 클러스터 ID로 합칠 때만 (E뒤 숫자). 새 클러스터로 묶을 거면 비워.",
                  },
                  target_new_cluster_key: {
                    type: "string",
                    description:
                      "새 클러스터로 묶을 때만 (new_clusters[].key와 매칭). 기존 합칠 거면 비워.",
                  },
                },
                required: ["new_insight_index"],
              },
            },
            new_clusters: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  key: {
                    type: "string",
                    description:
                      "decisions의 target_new_cluster_key와 매칭되는 임의 식별자",
                  },
                  theme: { type: "string", description: "클러스터 주제" },
                  angle: { type: "string", description: "글 작성 방향" },
                  quality_score: {
                    type: "number",
                    description: "1-5 (5=깊고 유익, 3=보통, 1=얕음)",
                  },
                  tech_stack: {
                    type: "array",
                    items: { type: "string" },
                    description: "이 클러스터의 대표 기술 스택",
                  },
                },
                required: [
                  "key",
                  "theme",
                  "angle",
                  "quality_score",
                  "tech_stack",
                ],
              },
            },
          },
          required: ["decisions", "new_clusters"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "route_insights" },
    messages: [
      {
        role: "user",
        content: `새 인사이트들을 기존 pending 클러스터에 "합칠지" 또는 "새 클러스터로 묶을지" 판단해줘.

규칙:
- 기존 클러스터 주제와 핵심 일치(같은 라이브러리/같은 문제 영역) → target_existing_cluster_id로 합쳐
- 그 외 → 새 클러스터 key 부여 후 묶고, new_clusters 배열에 그 key의 메타데이터 정의
- 비슷한 새 인사이트들끼리는 같은 새 클러스터 key로 묶을 수 있음
- 너무 얕거나 가치 없는 건 두 필드 모두 비워서 스킵
- "Next.js"와 "Next.js App Router"처럼 큰 우산 vs 세부 주제는 합치는 쪽으로

기존 pending 클러스터:
${candidateList}

새 인사이트:
${insightList}`,
      },
    ],
  });

  const toolUse = res.content.find((c) => c.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") return empty;

  const input = toolUse.input as {
    decisions: Array<{
      new_insight_index: number;
      target_existing_cluster_id?: number;
      target_new_cluster_key?: string;
    }>;
    new_clusters: Array<{
      key: string;
      theme: string;
      angle: string;
      quality_score: number;
      tech_stack: string[];
    }>;
  };

  const existingUpdates = new Map<number, Insight[]>();
  const newClusterMap = new Map<
    string,
    {
      theme: string;
      angle: string;
      qualityScore: number;
      techStack: string[];
      insights: Insight[];
    }
  >();
  for (const spec of input.new_clusters ?? []) {
    newClusterMap.set(spec.key, {
      theme: spec.theme,
      angle: spec.angle,
      qualityScore: spec.quality_score ?? 3,
      techStack: spec.tech_stack ?? [],
      insights: [],
    });
  }

  for (const d of input.decisions ?? []) {
    const insight = newInsights[d.new_insight_index];
    if (!insight) continue;
    if (d.target_existing_cluster_id != null) {
      const arr = existingUpdates.get(d.target_existing_cluster_id) ?? [];
      arr.push(insight);
      existingUpdates.set(d.target_existing_cluster_id, arr);
    } else if (
      d.target_new_cluster_key &&
      newClusterMap.has(d.target_new_cluster_key)
    ) {
      newClusterMap.get(d.target_new_cluster_key)!.insights.push(insight);
    }
  }

  return {
    existingUpdates,
    newClusters: Array.from(newClusterMap.values()).filter(
      (c) => c.insights.length > 0,
    ),
  };
}

// Insight → topic_clusters.insights JSONB 형식으로 변환
export function toStoredInsight(i: Insight): StoredInsight {
  return {
    topic: i.topic,
    summary: i.summary,
    techStack: i.techStack,
    sourceProject: i.sourceProject,
    excerpt: i.excerpt,
  };
}

// topic_clusters row 하나로 블로그 본문 생성 (Vercel function용)
export async function generateDraftFromStoredCluster(cluster: {
  theme: string;
  angle: string | null;
  insights: StoredInsight[];
}): Promise<DraftPost | null> {
  const pseudo: InsightCluster = {
    theme: cluster.theme,
    angle: cluster.angle ?? "",
    qualityScore: 3,
    insights: cluster.insights.map((s) => ({
      topic: s.topic,
      summary: s.summary,
      techStack: s.techStack,
      sourceProject: s.sourceProject,
      excerpt: s.excerpt,
    })),
  };
  return generateFromCluster(pseudo);
}
