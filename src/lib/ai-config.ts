import type OpenAI from "openai";

export type AiFeature =
  | "topic_suggestions"
  | "team_chat"
  | "team_research"
  | "exam_common"
  | "exam_team";

type AiRuntime = {
  model: string;
  reasoningEffort: "low";
};

const FEATURE_DEFAULTS: Record<AiFeature, { envName: string; model: string }> = {
  topic_suggestions: { envName: "OPENAI_TOPIC_MODEL", model: "gpt-5.6-terra" },
  team_chat: { envName: "OPENAI_TEAM_CHAT_MODEL", model: "gpt-5.6-luna" },
  team_research: { envName: "OPENAI_TEAM_RESEARCH_MODEL", model: "gpt-5.6-terra" },
  exam_common: { envName: "OPENAI_EXAM_MODEL", model: "gpt-5.6-sol" },
  exam_team: { envName: "OPENAI_EXAM_MODEL", model: "gpt-5.6-sol" },
};

const WEB_RESEARCH_PATTERN = /(?:출처|근거\s*(?:자료|링크)|논문|선행\s*연구|학술|검색|사이트|링크|최신|최근|기사|통계|실제\s*사례|웹\s*자료)/i;

export function getAiRuntime(feature: AiFeature): AiRuntime {
  const defaults = FEATURE_DEFAULTS[feature];
  return {
    model: process.env[defaults.envName]?.trim() || defaults.model,
    reasoningEffort: "low",
  };
}

export function shouldUseWebResearch(content: string) {
  return WEB_RESEARCH_PATTERN.test(content);
}

function safeErrorMetadata(error: unknown) {
  if (!error || typeof error !== "object") return { errorType: "UnknownError" };
  const candidate = error as { name?: unknown; status?: unknown; code?: unknown; type?: unknown };
  return {
    errorType: typeof candidate.name === "string" ? candidate.name : "UnknownError",
    ...(typeof candidate.status === "number" ? { status: candidate.status } : {}),
    ...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
    ...(typeof candidate.type === "string" ? { apiErrorType: candidate.type } : {}),
  };
}

export async function observeOpenAiRequest<T extends OpenAI.Responses.Response>(
  feature: AiFeature,
  requestedModel: string,
  request: () => Promise<T>,
) {
  const startedAt = Date.now();
  try {
    const response = await request();
    const usage = response.usage;
    const webSearchCalls = response.output.filter((item) => item.type === "web_search_call").length;
    console.info(JSON.stringify({
      severity: "INFO",
      event: "openai_usage",
      feature,
      requestedModel,
      actualModel: response.model,
      reasoningEffort: "low",
      durationMs: Date.now() - startedAt,
      inputTokens: usage?.input_tokens ?? null,
      cachedInputTokens: usage?.input_tokens_details.cached_tokens ?? null,
      cacheWriteTokens: usage?.input_tokens_details.cache_write_tokens ?? null,
      outputTokens: usage?.output_tokens ?? null,
      reasoningTokens: usage?.output_tokens_details.reasoning_tokens ?? null,
      totalTokens: usage?.total_tokens ?? null,
      webSearchCalls,
    }));
    return response;
  } catch (error) {
    console.warn(JSON.stringify({
      severity: "WARNING",
      event: "openai_failure",
      feature,
      requestedModel,
      reasoningEffort: "low",
      durationMs: Date.now() - startedAt,
      ...safeErrorMetadata(error),
    }));
    throw error;
  }
}
