import crypto from "crypto";
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

interface ContextTokenPayload {
  restaurantId: string;
  senderPhone: string;
  role: ResolvedSender["role"];
  exp: number;
}

const defaultHermesTimeoutMs = 45_000;
const contextTokenTtlMs = 2 * 60 * 1000;

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
  return (
    process.env.HERMES_API_KEY?.trim() ??
    process.env.HERMES_API_SERVER_KEY?.trim() ??
    null
  );
};

const getContextSecret = (): string => {
  return (
    process.env.HERMES_CONTEXT_SECRET?.trim() ??
    process.env.MCP_SHARED_SECRET?.trim() ??
    getHermesApiKey() ??
    "development-context-secret"
  );
};

const base64UrlEncode = (value: string): string => {
  return Buffer.from(value).toString("base64url");
};

const base64UrlDecode = (value: string): string => {
  return Buffer.from(value, "base64url").toString("utf8");
};

const signPayload = (payload: string): string => {
  return crypto.createHmac("sha256", getContextSecret()).update(payload).digest("base64url");
};

export const createHermesContextToken = (
  restaurantId: string,
  sender: ResolvedSender
): string => {
  const payload: ContextTokenPayload = {
    restaurantId,
    senderPhone: sender.normalizedPhone,
    role: sender.role,
    exp: Date.now() + contextTokenTtlMs
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));

  return `${encodedPayload}.${signPayload(encodedPayload)}`;
};

export const verifyHermesContextToken = (token: string): ContextTokenPayload | null => {
  const [encodedPayload, signature] = token.split(".");

  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = signPayload(encodedPayload);
  const signatureBuffer = Buffer.from(signature);
  const expectedSignatureBuffer = Buffer.from(expectedSignature);

  if (signatureBuffer.length !== expectedSignatureBuffer.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(signatureBuffer, expectedSignatureBuffer)) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload)) as ContextTokenPayload;

    if (!payload.restaurantId || !payload.senderPhone || !payload.role || payload.exp < Date.now()) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
};

export const isHermesAgentConfigured = (): boolean => {
  return Boolean(getHermesAgentUrl() && getHermesApiKey());
};

const buildConversationKey = (
  restaurantId: string,
  sender: ResolvedSender
): string => {
  return `${restaurantId}:${sender.normalizedPhone}`;
};

const buildHermesIdentityTag = (
  restaurant: IRestaurantDocument,
  sender: ResolvedSender,
  contextToken: string
): string => {
  return `[BACKEND IDENTITY TAG] ${JSON.stringify({
    sender_role: sender.role,
    phone: sender.normalizedPhone,
    sender_name: sender.name,
    verified_sender: sender.verified,
    restaurant_id: String(restaurant._id),
    restaurant_name: restaurant.name,
    cuisine: restaurant.primaryCuisine,
    contextToken
  })} Use your Hermes persona and memory. Use MCP restaurant tools for live menu/order data and mutations. Include contextToken in every MCP tool call. Confirm with the user before menu/order mutations.`;
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
  const contextToken = createHermesContextToken(restaurantId, sender);
  const conversationKey = buildConversationKey(restaurantId, sender);
  const usesResponsesApi = /\/responses\/?$/i.test(agentUrl);

  try {
    const response = await fetch(agentUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Hermes-Session-Key": conversationKey
      },
      body: JSON.stringify(
        usesResponsesApi
          ? {
              model: process.env.HERMES_AGENT_MODEL || "hermes-agent",
              input: `${buildHermesIdentityTag(restaurant, sender, contextToken)}\nUser message:\n${message}`,
              conversation: conversationKey,
              store: true
            }
          : {
              model: process.env.HERMES_AGENT_MODEL || "hermes-agent",
              messages: [
                {
                  role: "system",
                  content: buildHermesIdentityTag(restaurant, sender, contextToken)
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
