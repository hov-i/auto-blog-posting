import Anthropic from "@anthropic-ai/sdk";
import { ProjectConversation } from "./collect.js";

export interface DraftPost {
  title: string;
  description: string;
  content: string;
  tags: string[];
  sourceProject: string;
  conversation?: ProjectConversation; // 재생성용 소스 대화
}

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const BLOG_STYLE_TEMPLATE = `
## 블로그 글쓰기 스타일 가이드

### 공통 말투 & 톤
- 1인칭 경험담 중심 ("나는 ~했다", "~게 느꼈다", "~인 줄 알았는데")
- 딱딱하지 않고 솔직하게, 감정 자연스럽게 표현
- 말줄임표(..) 로 여운 남기기
- "사실 ~라는 단점이 있었는데", "생각보다 ~해서 감동 받았다..", "~게 마음에 들었다" 같은 표현 자주 사용
- 과도한 기술 용어 나열 금지, 맥락과 함께 설명

---

### 글 유형 1: 경험/회고 글 (프로젝트, 협업, 이벤트 참여 후기)

구조:
1. 헤더 없이 도입 문단 — 이 글을 쓰게 된 계기/맥락 1~2문장
2. ## 헤더로 섹션 구분
3. 기술 선택은 "왜 선택했는지", "어떤 점이 좋았는지" 위주로 풀어서 설명
4. 이슈/문제는 솔직하게 언급 후 어떻게 해결했는지 공유
5. 팀/협업 경험이면 팀원에 대한 감사함 자연스럽게 녹이기
6. 마지막: 회고 또는 앞으로의 계획으로 마무리 (희망적인 톤)
7. > 인용문으로 핵심 인사이트 강조 (선택)

예시 마무리 톤:
"팀원 모두 각자의 자리에서 최선을 다해줘서 정말 고마웠다. 짧지 않은 기간 동안 서로 의지하며 달려온 시간들이..."
"추후에는 기능 개선 사항을 반영하면서 고도화 작업 및 성능 최적화를 진행해보려한다."

---

### 글 유형 2: 기술 학습 정리 글 (개념 공부, 라이브러리 분석, 트러블슈팅)

구조:
1. 맨 첫 줄: > 블록쿼트로 이 글을 쓰게 된 상황 설명 + 왜 쓰게 됐는지 동기
   예시: > Recoil에 대해 공부하다가 Concurrent Mode라는 것을 접하게 되었다. 동시성 모드가 어떤 건지 의문점이 들어 이 글을 작성하게 되었다.
2. 빈 줄 하나 띄운 뒤 # 헤더로 첫 번째 섹션 시작 (## 아님, 반드시 # 사용)
3. 각 섹션은 # 헤더 + 설명 (bullet point, 코드블록 등 활용)
4. 글의 흐름은 "개념 소개 → 상세 설명 → 비교/분석 → 결론" 순서로
5. 코드 예시는 언어 명시한 코드블록으로
6. 비교/분석은 각 항목을 bullet point로 나열
7. 마지막 섹션은 반드시 # 마치며
   - 공부하면서 깨달은 점
   - 앞으로 어떻게 적용할지
   예시 톤: "지금 보니 ~라는 것을 깨닫게 되었다.", "앞으로 애플리케이션을 개발하면서 큰 도움이 될 것 같다."
8. 참고한 URL이 있으면 # 마치며 아래에 #### Reference 로 링크 목록 추가
   예시:
   #### Reference
   [링크 제목 - 출처](URL)

예시 전체 구조:
> (동기/계기 설명)

# 첫 번째 개념
- 설명...

# 두 번째 개념
- 설명...

# 마치며
느낀 점과 마무리 멘트...

#### Reference
[참고 링크](URL)

---

### 글 유형 선택 기준
- 프로젝트 경험, 협업, 이벤트, 회고 → 유형 1
- 개념 공부, 라이브러리 비교, 에러 해결, 기술 분석 → 유형 2
`;

export async function generateDraftPosts(
  conversation: ProjectConversation
): Promise<DraftPost[]> {
  const conversationText = conversation.messages
    .map((m) => `[${m.role === "user" ? "나" : "AI"}] ${m.text}`)
    .join("\n\n");

  const res = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8000,
    messages: [
      {
        role: "user",
        content: `아래는 "${conversation.projectName}" 프로젝트 개발 중 AI와 나눈 대화야.
이 대화에서 블로그 포스팅으로 만들 만한 내용을 뽑아서 블로그 글로 작성해줘.

${BLOG_STYLE_TEMPLATE}

⚠️ content 필드 작성 시 절대 규칙:
- 기술 학습 글이면 content의 첫 줄은 반드시 "> " 로 시작하는 blockquote여야 해 (이 글을 쓰게 된 계기/동기)
- 그 다음 줄부터 # 헤더로 섹션 시작
- 절대로 첫 줄에 # 헤더나 일반 텍스트로 시작하면 안 돼
- 경험/회고 글이면 헤더 없이 일반 텍스트 도입 문단으로 시작

올바른 기술 학습 글 content 시작 예시:
"> ~을 공부하다가 ~한 궁금증이 생겨서 이 글을 작성하게 되었다.\\n\\n# 첫 번째 섹션\\n..."

잘못된 예시 (절대 이렇게 하면 안 됨):
"# 첫 번째 섹션\\n..." (> blockquote 없이 바로 시작)

조건:
- 개발자 블로그 독자를 대상으로 작성
- 블로그 글이 1~3개 나올 수 있어 (내용이 여러 주제면 분리)
- 각 글은 아래 JSON 형식으로 반환

반드시 아래 JSON 배열 형식으로만 응답해. 다른 텍스트 없이:
[
  {
    "title": "글 제목",
    "description": "한 줄 요약 (미리보기용)",
    "content": "마크다운 본문 전체",
    "tags": ["태그1", "태그2"]
  }
]

대화 내용:
---
${conversationText}
---`,
      },
    ],
  });

  const text = res.content[0];
  if (text.type !== "text") return [];

  try {
    const cleaned = text.text
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    return parsed.map((p: Omit<DraftPost, "sourceProject" | "conversation">) => ({
      ...p,
      sourceProject: conversation.projectName,
      conversation,
    }));
  } catch {
    console.error(`❌ ${conversation.projectName} JSON 파싱 실패`);
    console.error("=== Claude 응답 원문 ===");
    console.error(text.text.slice(-300)); // 끝부분 확인 (잘렸는지 체크)
    console.error("========================");
    return [];
  }
}

export async function summarizeConversations(
  conversations: ProjectConversation[]
): Promise<DraftPost[]> {
  if (conversations.length === 0) {
    console.log("📭 이번 주 수집된 대화가 없어요!");
    return [];
  }

  const allDrafts: DraftPost[] = [];

  for (const conversation of conversations) {
    console.log(`\n✍️  "${conversation.projectName}" 요약 중...`);
    const drafts = await generateDraftPosts(conversation);
    console.log(`✅ ${drafts.length}개 초안 생성!`);
    allDrafts.push(...drafts);
  }

  console.log(`\n🎉 총 ${allDrafts.length}개 블로그 초안 생성 완료!`);
  return allDrafts;
}
