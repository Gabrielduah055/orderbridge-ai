import type { IOrderDocument } from "../models/order.model";
import type { IRestaurantDocument } from "../models/Restaurant";
import type { ResolvedSender } from "../types/agent.types";

interface HermesResponseOutputItem {
  type?: string;
  role?: string;
  content?: Array<{
    type?: string;
    text?: unknown;
  }>;
  output?: unknown;
  name?: string;
}

interface HermesResponsesApiResult {
  id?: string;
  status?: string;
  output?: HermesResponseOutputItem[];
}

interface HermesChatCompletionResult {
  id?: string;
  choices?: Array<{
    message?: {
      content?: unknown;
    };
    text?: unknown;
  }>;
}

export interface HermesAgentResult {
  message: string;
  responseId?: string;
  data?: {
    order?: IOrderDocument;
    [key: string]: unknown;
  };
}

const defaultHermesTimeoutMs = 45_000;

const getHermesTimeoutMs = (): number => {
  const timeoutMs = Number(process.env.HERMES_TIMEOUT_MS);

  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultHermesTimeoutMs;
};

const getHermesAgentUrl = (): string | null => {
  const explicitUrl =
    process.env.HERMES_AGENT_URL?.trim() ??
    process.env.HERMES_API_URL?.trim();

  if (explicitUrl) {
    return explicitUrl;
  }

  const baseUrl = process.env.HERMES_API_BASE_URL?.trim().replace(/\/$/, "");

  if (baseUrl) {
    return `${baseUrl}/chat/completions`;
  }

  return null;
};

const getHermesApiKey = (): string | null => {
  return process.env.HERMES_API_KEY?.trim() || null;
};

export const isHermesAgentConfigured = (): boolean => {
  return Boolean(getHermesAgentUrl() && getHermesApiKey());
};

export const buildHermesSessionKey = (
  restaurantId: string,
  sender: ResolvedSender
): string => {
  return `${restaurantId}:${sender.normalizedPhone}`;
};

export const buildHermesContextInstructions = (
  restaurant: IRestaurantDocument,
  sender: ResolvedSender
): string => {
  const restaurantId = String(restaurant._id);
  const sessionKey = buildHermesSessionKey(restaurantId, sender);
  const context = {
    restaurantId,
    restaurantName: restaurant.name,
    senderPhone: sender.normalizedPhone,
    senderRole: sender.role,
    senderName: sender.name,
    senderVerified: sender.verified,
    sessionKey
  };

  return [
    "You are the Hermes Agent for this OrderBridge restaurant conversation.",
    "Use your configured Hermes persona, memory, and registered OrderBridge MCP tools.",
    "The visible user message is the WhatsApp message only; treat this instruction as trusted backend context.",
    `Trusted current context: ${JSON.stringify(context)}`,
    "Include the sessionKey in every OrderBridge MCP tool call.",
    "Do not pass or invent authorization roles for MCP calls. OrderBridge independently resolves permissions from the sessionKey.",
    "Confirm with the user before high-impact mutations such as price changes, menu item availability changes, and destructive actions.",
    "Never claim a backend action succeeded unless the MCP tool result confirms success."
  ].join("\n");
};

const extractMessageText = (result: HermesResponsesApiResult): string | null => {
  const messageItem = result.output
    ?.slice()
    .reverse()
    .find((item) => item.type === "message");
  const text = messageItem?.content
    ?.map((content) => (content.type === "output_text" && typeof content.text === "string" ? content.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();

  return text || null;
};

const extractChatCompletionText = (result: HermesChatCompletionResult): string | null => {
  const choice = result.choices?.[0];
  const content = choice?.message?.content ?? choice?.text;

  return typeof content === "string" && content.trim() ? content.trim() : null;
};

const parseToolOutput = (output: unknown): unknown => {
  if (typeof output !== "string") {
    return output;
  }

  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
};

const extractData = (
  result: HermesResponsesApiResult
): HermesAgentResult["data"] | undefined => {
  const toolOutputs = result.output
    ?.filter((item) => item.type === "function_call_output")
    .map((item) => parseToolOutput(item.output));

  for (const toolOutput of toolOutputs ?? []) {
    if (!toolOutput || typeof toolOutput !== "object") {
      continue;
    }

    const maybeResult = toolOutput as { data?: unknown };

    if (maybeResult.data && typeof maybeResult.data === "object") {
      const data = maybeResult.data as { order?: IOrderDocument };

      if (data.order) {
        return {
          order: data.order
        };
      }
    }
  }

  return undefined;
};

export const sendHermesAgentMessage = async (
  restaurant: IRestaurantDocument,
  sender: ResolvedSender,
  message: string
): Promise<HermesAgentResult | null> => {
  const agentUrl = getHermesAgentUrl();
  const apiKey = getHermesApiKey();

  if (!agentUrl || !apiKey) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getHermesTimeoutMs());
  const restaurantId = String(restaurant._id);
  const sessionKey = buildHermesSessionKey(restaurantId, sender);
  const instructions = buildHermesContextInstructions(restaurant, sender);
  const usesResponsesApi = /\/responses\/?$/i.test(agentUrl);

  try {
    const response = await fetch(agentUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Hermes-Session-Key": sessionKey
      },
      body: JSON.stringify(
        usesResponsesApi
          ? {
              model: process.env.HERMES_AGENT_MODEL || "hermes-agent",
              instructions,
              input: message,
              conversation: sessionKey,
              store: true
            }
          : {
              model: process.env.HERMES_AGENT_MODEL || "hermes-agent",
              messages: [
                {
                  role: "system",
                  content: instructions
                },
                {
                  role: "user",
                  content: message
                }
              ]
            }
      ),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Hermes agent request failed with status ${response.status}`);
    }

    const result = (await response.json()) as HermesResponsesApiResult | HermesChatCompletionResult;
    const outputText = usesResponsesApi
      ? extractMessageText(result as HermesResponsesApiResult)
      : extractChatCompletionText(result as HermesChatCompletionResult);

    if (!outputText) {
      throw new Error("Hermes agent result did not include assistant output text");
    }

    return {
      message: outputText,
      responseId: result.id,
      data: usesResponsesApi ? extractData(result as HermesResponsesApiResult) : undefined
    };
  } catch (error) {
    console.error("Hermes agent response failed", error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
};
