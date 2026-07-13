import crypto from "crypto";

export type WasenderMessageType = "text" | "image" | "document" | "unknown";

export interface NormalizedWasenderWebhook {
  sessionId: string;
  from: string;
  message: string;
  messageType: WasenderMessageType;
  mediaUrl?: string;
  messageId?: string;
  receiver?: string;
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
    "message.messageType"
  ])?.toLowerCase();

  if (explicitType?.includes("image")) {
    return "image";
  }

  if (explicitType?.includes("document") || explicitType?.includes("file")) {
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
    "key.id"
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
    message,
    type: "text"
  });
};

export const sendDocumentMessage = async (
  sessionId: string,
  to: string,
  fileUrl: string,
  caption?: string
): Promise<WasenderSendResult> => {
  return postToWasender("/api/send-document", {
    sessionId,
    to,
    fileUrl,
    caption,
    type: "document"
  });
};

export const normalizeIncomingWebhook = (payload: unknown): NormalizedWasenderWebhook => {
  const rawPayload =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const message = firstString(rawPayload, [
    "message",
    "text",
    "body",
    "data.message",
    "data.text",
    "data.body",
    "message.text",
    "message.body",
    "message.conversation",
    "data.message.text",
    "data.message.body",
    "data.message.conversation"
  ]);
  const sessionId =
    firstString(rawPayload, [
      "sessionId",
      "session_id",
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
    firstString(rawPayload, [
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
      "message.to"
    ])
  );
  const mediaUrl = firstString(rawPayload, [
    "mediaUrl",
    "media_url",
    "fileUrl",
    "file_url",
    "imageUrl",
    "documentUrl",
    "data.mediaUrl",
    "data.fileUrl",
    "message.mediaUrl"
  ]);
  const messageId = buildWebhookEventId(rawPayload);

  return {
    sessionId,
    from,
    message: message ?? "",
    messageType: detectMessageType(rawPayload, message),
    mediaUrl,
    messageId,
    receiver: receiver || undefined,
    rawPayload
  };
};
