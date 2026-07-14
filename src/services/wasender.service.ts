import crypto from "crypto";

export type WasenderMessageType = "text" | "image" | "document" | "unknown";

export interface NormalizedWasenderWebhook {
  event?: string;
  sessionId: string;
  from: string;
  message: string;
  messageType: WasenderMessageType;
  mediaUrl?: string;
  messageId?: string;
  receiver?: string;
  fromMe?: boolean;
  rawPayload: Record<string, unknown>;
}

interface WasenderSendResult {
  success: boolean;
  status?: number;
  data?: unknown;
  error?: string;
}

const getWasenderConfig = (): { apiUrl: string; apiKey: string } | null => {
  const apiUrl = process.env.WASENDER_API_URL;
  const apiKey = process.env.WASENDER_API_KEY;

  if (!apiUrl || !apiKey) {
    return null;
  }

  return {
    apiUrl: apiUrl.replace(/\/$/, ""),
    apiKey
  };
};

const getNestedValue = (value: unknown, path: string): unknown => {
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") {
      return undefined;
    }

    return (current as Record<string, unknown>)[key];
  }, value);
};

const firstString = (payload: unknown, paths: string[]): string | undefined => {
  for (const path of paths) {
    const value = getNestedValue(payload, path);

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
};

const firstStringFromSources = (
  sources: unknown[],
  paths: string[]
): string | undefined => {
  for (const source of sources) {
    const value = firstString(source, paths);

    if (value) {
      return value;
    }
  }

  return undefined;
};

const firstBoolean = (payload: unknown, paths: string[]): boolean | undefined => {
  for (const path of paths) {
    const value = getNestedValue(payload, path);

    if (typeof value === "boolean") {
      return value;
    }
  }

  return undefined;
};

const hasNestedValue = (value: unknown, path: string): boolean => {
  return getNestedValue(value, path) !== undefined;
};

const getPrimaryMessagePayload = (payload: Record<string, unknown>): unknown => {
  const messages = getNestedValue(payload, "data.messages");

  if (Array.isArray(messages)) {
    return (
      messages.find((message) => firstBoolean(message, ["key.fromMe"]) === false) ??
      messages[0]
    );
  }

  return messages;
};

const cleanWhatsappAddress = (value?: string): string => {
  if (!value) {
    return "";
  }

  return value
    .replace(/@s\.whatsapp\.net$/i, "")
    .replace(/@c\.us$/i, "")
    .replace(/^whatsapp:/i, "")
    .trim();
};

const detectMessageType = (payload: unknown, messageText?: string): WasenderMessageType => {
  const explicitType = firstString(payload, [
    "messageType",
    "type",
    "data.messageType",
    "data.type",
    "message.type",
    "message.messageType",
    "message.messageType.type"
  ])?.toLowerCase();

  if (explicitType?.includes("image")) {
    return "image";
  }

  if (explicitType?.includes("document") || explicitType?.includes("file")) {
    return "document";
  }

  if (hasNestedValue(payload, "message.imageMessage") || hasNestedValue(payload, "imageMessage")) {
    return "image";
  }

  if (
    hasNestedValue(payload, "message.documentMessage") ||
    hasNestedValue(payload, "documentMessage")
  ) {
    return "document";
  }

  if (messageText) {
    return "text";
  }

  return "unknown";
};

const buildWebhookEventId = (payload: unknown): string => {
  const explicitId = firstString(payload, [
    "eventId",
    "event_id",
    "id",
    "messageId",
    "message_id",
    "data.id",
    "data.messageId",
    "message.id",
    "key.id",
    "data.messages.key.id"
  ]);

  if (explicitId) {
    return explicitId;
  }

  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
};

const postToWasender = async (
  path: string,
  body: Record<string, unknown>
): Promise<WasenderSendResult> => {
  const config = getWasenderConfig();

  if (!config) {
    const error = "Wasender API is not configured";
    console.error(error);
    return {
      success: false,
      error
    };
  }

  const normalizedPath =
    config.apiUrl.endsWith("/api") && path.startsWith("/api/")
      ? path.replace(/^\/api/, "")
      : path;
  const url = `${config.apiUrl}${normalizedPath}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const contentType = response.headers.get("content-type") ?? "";
    const data = contentType.includes("application/json")
      ? ((await response.json()) as unknown)
      : await response.text();

    if (!response.ok) {
      console.error("Wasender API send failed", {
        status: response.status,
        data
      });

      return {
        success: false,
        status: response.status,
        data,
        error: `Wasender API request failed with status ${response.status}`
      };
    }

    return {
      success: true,
      status: response.status,
      data
    };
  } catch (error) {
    console.error("Wasender API send failed", error);

    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown Wasender API error"
    };
  }
};

export const sendTextMessage = async (
  sessionId: string,
  to: string,
  message: string
): Promise<WasenderSendResult> => {
  return postToWasender("/api/send-message", {
    sessionId,
    to,
    text: message
  });
};

export const sendDocumentMessage = async (
  sessionId: string,
  to: string,
  fileUrl: string,
  caption?: string
): Promise<WasenderSendResult> => {
  return postToWasender("/api/send-message", {
    sessionId,
    to,
    documentUrl: fileUrl,
    text: caption
  });
};

export const normalizeIncomingWebhook = (payload: unknown): NormalizedWasenderWebhook => {
  const rawPayload =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const messagePayload = getPrimaryMessagePayload(rawPayload);
  const event = firstString(rawPayload, ["event", "type"]);
  const message = firstStringFromSources([messagePayload, rawPayload], [
    "message",
    "text",
    "body",
    "messageBody",
    "data.message",
    "data.text",
    "data.body",
    "data.messages.messageBody",
    "message.text",
    "message.body",
    "message.conversation",
    "message.extendedTextMessage.text",
    "message.imageMessage.caption",
    "message.videoMessage.caption",
    "message.documentMessage.caption",
    "data.message.text",
    "data.message.body",
    "data.message.conversation",
    "data.message.messageBody"
  ]);
  const sessionId =
    firstString(rawPayload, [
      "params.sessionId",
      "query.wasenderSessionId",
      "query.whatsappSessionId",
      "query.sessionId",
      "sessionId",
      "session_id",
      "wasenderSessionId",
      "whatsappSessionId",
      "whatsapp_session_id",
      "instanceId",
      "instance_id",
      "deviceId",
      "device_id",
      "data.sessionId",
      "data.session_id",
      "session.id",
      "data.session.id"
    ]) ?? "";
  const from = cleanWhatsappAddress(
    firstStringFromSources([messagePayload, rawPayload], [
      "key.cleanedParticipantPn",
      "key.cleanedSenderPn",
      "key.senderPn",
      "key.participant",
      "key.remoteJid",
      "from",
      "sender",
      "senderPhone",
      "fromNumber",
      "data.from",
      "data.sender",
      "data.senderPhone",
      "message.from",
      "key.remoteJid"
    ])
  );
  const receiver = cleanWhatsappAddress(
    firstString(rawPayload, [
      "to",
      "receiver",
      "recipient",
      "businessNumber",
      "whatsappNumber",
      "data.to",
      "data.receiver",
      "data.recipient",
      "data.businessNumber",
      "message.to",
      "query.receiver",
      "query.whatsappNumber",
      "query.businessNumber"
    ])
  );
  const mediaUrl = firstStringFromSources([messagePayload, rawPayload], [
    "mediaUrl",
    "media_url",
    "fileUrl",
    "file_url",
    "imageUrl",
    "documentUrl",
    "data.mediaUrl",
    "data.fileUrl",
    "message.mediaUrl",
    "message.imageMessage.url",
    "message.videoMessage.url",
    "message.documentMessage.url"
  ]);
  const messageId =
    firstString(messagePayload, ["key.id", "id", "messageId"]) ??
    buildWebhookEventId(rawPayload);
  const fromMe = firstBoolean(messagePayload, ["key.fromMe", "fromMe"]);

  return {
    event,
    sessionId,
    from,
    message: message ?? "",
    messageType: detectMessageType(messagePayload ?? rawPayload, message),
    mediaUrl,
    messageId,
    receiver: receiver || undefined,
    fromMe,
    rawPayload
  };
};
