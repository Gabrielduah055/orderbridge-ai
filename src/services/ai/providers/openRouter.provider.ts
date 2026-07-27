import { getOpenRouterConfig } from "../ai.config";
import type {
  AiMessage,
  AiProvider,
  AiProviderRequest,
  AiProviderResponse,
  AiToolCall
} from "../ai.types";

interface OpenRouterToolCall {
  id?: string;
  function?: {
    name?: unknown;
    arguments?: unknown;
  };
}

interface OpenRouterChatResult {
  id?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: unknown;
      tool_calls?: OpenRouterToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

const parseToolArguments = (value: unknown): Record<string, unknown> => {
  if (!value) {
    return {};
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value !== "string" || !value.trim()) {
    return {};
  }

  const parsed = JSON.parse(value) as unknown;

  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
};

const normalizeToolCalls = (toolCalls?: OpenRouterToolCall[]): AiToolCall[] => {
  return (toolCalls ?? [])
    .map((toolCall, index) => {
      const name = toolCall.function?.name;

      if (typeof name !== "string" || !name.trim()) {
        return null;
      }

      return {
        id: toolCall.id ?? `tool_call_${index}`,
        name,
        arguments: parseToolArguments(toolCall.function?.arguments)
      };
    })
    .filter((toolCall): toolCall is AiToolCall => Boolean(toolCall));
};

const toOpenRouterMessage = (message: AiMessage) => {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      name: message.name,
      content: message.content ?? ""
    };
  }

  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content ?? null,
      tool_calls: message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments)
        }
      }))
    };
  }

  return {
    role: message.role,
    content: message.content ?? ""
  };
};

export class OpenRouterProvider implements AiProvider {
  name = "openrouter" as const;
  model: string;

  constructor() {
    const config = getOpenRouterConfig();

    if (!config.apiKey || !config.model) {
      throw new Error("OpenRouter is not configured.");
    }

    this.model = config.model;
  }

  async complete(request: AiProviderRequest): Promise<AiProviderResponse> {
    const config = getOpenRouterConfig();

    if (!config.apiKey || !config.model) {
      throw new Error("OpenRouter is not configured.");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    const startedAt = Date.now();

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json"
      };

      if (config.siteUrl) {
        headers["HTTP-Referer"] = config.siteUrl;
      }

      if (config.appName) {
        headers["X-Title"] = config.appName;
      }

      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: config.model,
          messages: request.messages.map(toOpenRouterMessage),
          tools: request.tools,
          tool_choice: request.toolChoice ?? "auto",
          max_tokens: config.maxOutputTokens,
          parallel_tool_calls: false
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");

        throw new Error(
          `OpenRouter request failed with status ${response.status}${
            errorBody ? `: ${errorBody.slice(0, 300)}` : ""
          }`
        );
      }

      const result = (await response.json()) as OpenRouterChatResult;
      const choice = result.choices?.[0];
      const message = choice?.message;

      if (!message) {
        throw new Error("OpenRouter response did not include a message.");
      }

      const text = typeof message.content === "string" ? message.content.trim() : undefined;
      const toolCalls = normalizeToolCalls(message.tool_calls);

      if (!text && toolCalls.length === 0) {
        throw new Error("OpenRouter response did not include text or tool calls.");
      }

      console.info("OpenRouter completion received", {
        provider: this.name,
        model: config.model,
        finishReason: choice?.finish_reason,
        toolCallCount: toolCalls.length,
        latencyMs: Date.now() - startedAt,
        totalTokens: result.usage?.total_tokens
      });

      return {
        id: result.id,
        text,
        toolCalls,
        finishReason: choice?.finish_reason,
        usage: result.usage
          ? {
              inputTokens: result.usage.prompt_tokens,
              outputTokens: result.usage.completion_tokens,
              totalTokens: result.usage.total_tokens
            }
          : undefined
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown OpenRouter error";

      console.error("OpenRouter completion failed", {
        provider: this.name,
        model: config.model,
        latencyMs: Date.now() - startedAt,
        error: message
      });

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
