import crypto from "crypto";
import { getSafeErrorMessage } from "../utils/error.util";
import { normalizeGhanaPhone } from "../utils/phone.util";

export type WasenderMessageType = "text" | "image" | "document" | "unknown";
export type WasenderAddressingMode = "pn" | "lid";
export type WasenderSenderPhoneSource =
  | "cleanedParticipantPn"
  | "cleanedSenderPn"
  | "senderPn"
  | "participant"
  | "remoteJid"
  | "senderPhone";

export interface NormalizedWasenderWebhook {
  event?: string;
  sessionId: string;
  from: string;
  senderPhone?: string;
  senderPhoneSource?: WasenderSenderPhoneSource;
  senderLid?: string;
  senderAddress: string;
  addressingMode?: WasenderAddressingMode;
  hasCleanedParticipantPn: boolean;
  hasCleanedSenderPn: boolean;
  hasSenderPn: boolean;
  message: string;
  messageType: WasenderMessageType;
  mediaUrl?: string;
  messageId?: string;
  quotedMessageId?: string;
  receiver?: string;
  fromMe?: boolean;
  rawMessage: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
}

export interface WasenderSendResult {
  success: boolean;
  status?: number;
  data?: unknown;
  error?: string;
}

export interface WasenderSendOptions {
  apiKey?: string;
}

export interface WasenderLidResolutionResult extends WasenderSendResult {
  phone?: string;
}

const defaultWasenderApiUrl = "https://www.wasenderapi.com";
const allowedMenuItemImageMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp"
]);
const maxMenuItemImageBytes = 5 * 1024 * 1024;

const getWasenderConfig = (
  options: WasenderSendOptions = {}
): { apiUrl: string; apiKey: string } | null => {
  const configuredApiUrl = process.env.WASENDER_API_URL?.trim();
  const apiUrl =
    configuredApiUrl && !configuredApiUrl.includes("/api/webhooks/wasender")
      ? configuredApiUrl
      : defaultWasenderApiUrl;
  const apiKey = options.apiKey?.trim() || process.env.WASENDER_API_KEY?.trim();

  if (configuredApiUrl?.includes("/api/webhooks/wasender")) {
    console.warn("Ignoring invalid WASENDER_API_URL because it points to the inbound webhook", {
      configuredApiUrl,
      fallbackApiUrl: defaultWasenderApiUrl
    });
  }

  if (!apiKey) {
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

export const validateWasenderMenuItemImageMetadata = (
  rawMessage: Record<string, unknown>
): void => {
  const mimeType = firstString(rawMessage, [
    "message.imageMessage.mimetype",
    "imageMessage.mimetype",
    "message.imageMessage.mimeType",
    "imageMessage.mimeType"
  ])?.toLowerCase();
  const fileLengthValue = [
    "message.imageMessage.fileLength",
    "imageMessage.fileLength",
    "message.imageMessage.fileSize",
    "imageMessage.fileSize"
  ]
    .map((path) => getNestedValue(rawMessage, path))
    .find((value) => value !== undefined && value !== null);
  const fileLength =
    typeof fileLengthValue === "number"
      ? fileLengthValue
      : typeof fileLengthValue === "string" && fileLengthValue.trim()
        ? Number(fileLengthValue)
        : undefined;

  if (mimeType && !allowedMenuItemImageMimeTypes.has(mimeType)) {
    throw new Error("The image must be a JPG, PNG, or WEBP file.");
  }

  if (
    fileLengthValue !== undefined &&
    (fileLength === undefined || !Number.isFinite(fileLength) || fileLength < 0)
  ) {
    throw new Error("The image size metadata is invalid.");
  }

  if (
    fileLength !== undefined &&
    Number.isFinite(fileLength) &&
    fileLength > maxMenuItemImageBytes
  ) {
    throw new Error("The image must be 5 MB or smaller.");
  }
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

export const normalizeWhatsappLid = (value?: string): string => {
  if (!value) {
    return "";
  }

  const address = value.replace(/^whatsapp:/i, "").trim().toLowerCase();

  return /^[a-z0-9._-]+@lid$/i.test(address) ? address : "";
};

const cleanWhatsappAddress = (value?: string): string => {
  if (!value) {
    return "";
  }

  const lid = normalizeWhatsappLid(value);

  if (lid) {
    return lid;
  }

  const address = value
    .replace(/^whatsapp:/i, "")
    .replace(/@s\.whatsapp\.net$/i, "")
    .replace(/@c\.us$/i, "")
    .trim();

  return address.includes("@") ? "" : address;
};

const normalizeWhatsappPhoneAddress = (value?: string): string => {
  if (!value || normalizeWhatsappLid(value)) {
    return "";
  }

  const address = value.replace(/^whatsapp:/i, "").trim();

  if (address.includes("@") && !/@(?:s\.whatsapp\.net|c\.us)$/i.test(address)) {
    return "";
  }

  return normalizeGhanaPhone(address);
};

const firstWhatsappPhone = (
  sources: unknown[],
  candidates: Array<{ path: string; source: WasenderSenderPhoneSource }>
): { phone?: string; source?: WasenderSenderPhoneSource } => {
  for (const candidate of candidates) {
    const value = firstStringFromSources(sources, [candidate.path]);
    const phone = normalizeWhatsappPhoneAddress(value);

    if (phone) {
      return { phone, source: candidate.source };
    }
  }

  return {};
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

export const extractWasenderProviderMessageId = (payload: unknown): string | undefined => {
  return firstString(payload, [
    "messageId",
    "message_id",
    "id",
    "data.messageId",
    "data.message_id",
    "data.id",
    "data.key.id",
    "key.id"
  ]);
};

const postToWasender = async (
  path: string,
  body: Record<string, unknown>,
  options: WasenderSendOptions = {}
): Promise<WasenderSendResult> => {
  const config = getWasenderConfig(options);

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
  const recipientAddressingMode = normalizeWhatsappLid(
    typeof body.to === "string" ? body.to : undefined
  )
    ? "lid"
    : "pn";

  try {
    console.info("Wasender API send attempt", {
      path: normalizedPath,
      recipientAddressingMode,
      usesRestaurantApiToken: Boolean(options.apiKey?.trim()),
      hasText: typeof body.text === "string" && body.text.length > 0,
      hasDocumentUrl: typeof body.documentUrl === "string" && body.documentUrl.length > 0
    });

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

    const explicitFailure =
      data &&
      typeof data === "object" &&
      "success" in data &&
      (data as { success?: unknown }).success === false;

    if (!response.ok || explicitFailure) {
      const providerError = getSafeErrorMessage(
        data,
        explicitFailure
          ? "Wasender API returned success=false"
          : `Wasender API request failed with status ${response.status}`
      );

      console.error("Wasender API send failed", {
        status: response.status,
        error: providerError,
        recipientAddressingMode
      });

      return {
        success: false,
        status: response.status,
        data,
        error: providerError
      };
    }

    console.info("Wasender API send accepted", {
      status: response.status,
      recipientAddressingMode
    });

    return {
      success: true,
      status: response.status,
      data
    };
  } catch (error) {
    console.error("Wasender API send failed", error);

    return {
      success: false,
      error: getSafeErrorMessage(error, "Wasender API request failed")
    };
  }
};

const normalizeWasenderPath = (apiUrl: string, path: string): string => {
  return apiUrl.endsWith("/api") && path.startsWith("/api/")
    ? path.replace(/^\/api/, "")
    : path;
};

const isHttpUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
};

export const resolveWasenderPhoneFromLid = async (
  lid: string,
  options: WasenderSendOptions = {}
): Promise<WasenderLidResolutionResult> => {
  const normalizedLid = normalizeWhatsappLid(lid);

  if (!normalizedLid) {
    return {
      success: false,
      error: "Invalid WhatsApp LID"
    };
  }

  const config = getWasenderConfig(options);

  if (!config) {
    return {
      success: false,
      error: "Wasender API is not configured"
    };
  }

  const path = normalizeWasenderPath(
    config.apiUrl,
    `/api/pn-from-lid/${encodeURIComponent(normalizedLid)}`
  );

  try {
    const response = await fetch(`${config.apiUrl}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: "application/json"
      }
    });
    const contentType = response.headers.get("content-type") ?? "";
    const data = contentType.includes("application/json")
      ? ((await response.json()) as unknown)
      : await response.text();
    const explicitFailure =
      data &&
      typeof data === "object" &&
      "success" in data &&
      (data as { success?: unknown }).success === false;

    if (!response.ok || explicitFailure) {
      return {
        success: false,
        status: response.status,
        data,
        error: getSafeErrorMessage(
          data,
          `Wasender LID resolution failed with status ${response.status}`
        )
      };
    }

    const phone = normalizeWhatsappPhoneAddress(
      firstString(data, ["data.pn", "pn"])
    );

    if (!phone) {
      return {
        success: false,
        status: response.status,
        data,
        error: "Wasender LID resolution returned no valid phone number"
      };
    }

    return {
      success: true,
      status: response.status,
      data,
      phone
    };
  } catch (error) {
    return {
      success: false,
      error: getSafeErrorMessage(error, "Wasender LID resolution request failed")
    };
  }
};

/**
 * Sends the complete raw WhatsApp message object to WaSender so its media key,
 * encrypted URL, hashes, and message ID stay together for server-side decryption.
 */
export const decryptWasenderMedia = async (
  rawMessage: Record<string, unknown>,
  options: WasenderSendOptions = {}
): Promise<string> => {
  const config = getWasenderConfig(options);

  if (!config) {
    throw new Error(
      "WaSender media decryption is not configured. Set a restaurant WaSender API token or WASENDER_API_KEY."
    );
  }

  const path = normalizeWasenderPath(config.apiUrl, "/api/decrypt-media");
  const messageId = firstString(rawMessage, ["key.id", "id", "messageId"]);

  console.info("Wasender media decryption attempt", {
    messageId,
    usesRestaurantApiToken: Boolean(options.apiKey?.trim())
  });

  let response: Response;

  try {
    response = await fetch(`${config.apiUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        data: {
          messages: rawMessage
        }
      })
    });
  } catch (error) {
    throw new Error(
      `WaSender media decryption request failed: ${getSafeErrorMessage(
        error,
        "network request failed"
      )}`
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  const data = contentType.includes("application/json")
    ? ((await response.json()) as unknown)
    : await response.text();
  const explicitFailure =
    data &&
    typeof data === "object" &&
    "success" in data &&
    (data as { success?: unknown }).success === false;

  if (!response.ok || explicitFailure) {
    throw new Error(
      `WaSender media decryption failed with status ${response.status}: ${getSafeErrorMessage(
        data,
        "provider rejected the decryption request"
      )}`
    );
  }

  const publicUrl = firstString(data, ["publicUrl", "data.publicUrl"]);

  if (!publicUrl || !isHttpUrl(publicUrl)) {
    throw new Error("WaSender media decryption succeeded but returned no valid publicUrl.");
  }

  console.info("Wasender media decryption completed", {
    messageId,
    status: response.status
  });

  return publicUrl;
};

export const sendTextMessage = async (
  sessionId: string,
  to: string,
  message: string,
  options: WasenderSendOptions = {}
): Promise<WasenderSendResult> => {
  void sessionId;

  return postToWasender("/api/send-message", {
    to,
    text: message
  }, options);
};

export const sendDocumentMessage = async (
  sessionId: string,
  to: string,
  fileUrl: string,
  caption?: string,
  options: WasenderSendOptions = {}
): Promise<WasenderSendResult> => {
  void sessionId;

  return postToWasender("/api/send-message", {
    to,
    documentUrl: fileUrl,
    ...(caption?.trim() ? { text: caption } : {})
  }, options);
};

export const sendImageMessage = async (
  sessionId: string,
  to: string,
  imageUrl: string,
  caption?: string,
  options: WasenderSendOptions = {}
): Promise<WasenderSendResult> => {
  void sessionId;

  // Fix: omit `text` entirely when caption is blank — sending text: "" causes WaSender to reject the image message
  return postToWasender("/api/send-message", {
    to,
    imageUrl,
    ...(caption?.trim() ? { text: caption } : {})
  }, options);
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
  const senderSources = [messagePayload, rawPayload];
  const cleanedParticipantPn = firstStringFromSources(senderSources, [
    "key.cleanedParticipantPn",
    "data.messages.key.cleanedParticipantPn"
  ]);
  const cleanedSenderPn = firstStringFromSources(senderSources, [
    "key.cleanedSenderPn",
    "data.messages.key.cleanedSenderPn"
  ]);
  const senderPn = firstStringFromSources(senderSources, [
    "key.senderPn",
    "data.messages.key.senderPn"
  ]);
  const phoneIdentity = firstWhatsappPhone(senderSources, [
    { path: "key.cleanedParticipantPn", source: "cleanedParticipantPn" },
    { path: "data.messages.key.cleanedParticipantPn", source: "cleanedParticipantPn" },
    { path: "key.cleanedSenderPn", source: "cleanedSenderPn" },
    { path: "data.messages.key.cleanedSenderPn", source: "cleanedSenderPn" },
    { path: "key.senderPn", source: "senderPn" },
    { path: "data.messages.key.senderPn", source: "senderPn" },
    { path: "key.participant", source: "participant" },
    { path: "data.messages.key.participant", source: "participant" },
    { path: "senderPhone", source: "senderPhone" },
    { path: "fromNumber", source: "senderPhone" },
    { path: "data.senderPhone", source: "senderPhone" },
    { path: "key.remoteJid", source: "remoteJid" },
    { path: "data.messages.key.remoteJid", source: "remoteJid" },
    { path: "from", source: "senderPhone" },
    { path: "sender", source: "senderPhone" },
    { path: "data.from", source: "senderPhone" },
    { path: "data.sender", source: "senderPhone" },
    { path: "message.from", source: "senderPhone" }
  ]);
  const rawRemoteAddress = firstStringFromSources(senderSources, [
    "key.participant",
    "data.messages.key.participant",
    "key.remoteJid",
    "data.messages.key.remoteJid",
    "from",
    "sender",
    "data.from",
    "data.sender",
    "message.from"
  ]);
  const explicitSenderLid = firstStringFromSources(senderSources, [
    "key.senderLid",
    "data.messages.key.senderLid",
    "senderLid",
    "data.senderLid"
  ]);
  const senderLid =
    normalizeWhatsappLid(explicitSenderLid) ||
    normalizeWhatsappLid(rawRemoteAddress) ||
    undefined;
  const explicitAddressingMode = firstStringFromSources(senderSources, [
    "key.addressingMode",
    "data.messages.key.addressingMode",
    "addressingMode",
    "data.addressingMode"
  ])?.toLowerCase();
  const addressingMode: WasenderAddressingMode | undefined =
    explicitAddressingMode === "lid" || explicitAddressingMode === "pn"
      ? explicitAddressingMode
      : normalizeWhatsappLid(rawRemoteAddress)
        ? "lid"
        : phoneIdentity.phone
          ? "pn"
          : undefined;
  const senderAddress =
    rawRemoteAddress?.replace(/^whatsapp:/i, "").trim() ??
    senderLid ??
    phoneIdentity.phone ??
    "";
  const from = cleanWhatsappAddress(
    firstStringFromSources(senderSources, [
      "key.cleanedParticipantPn",
      "data.messages.key.cleanedParticipantPn",
      "key.cleanedSenderPn",
      "data.messages.key.cleanedSenderPn",
      "key.senderPn",
      "data.messages.key.senderPn",
      "key.participant",
      "data.messages.key.participant",
      "key.remoteJid",
      "data.messages.key.remoteJid",
      "from",
      "sender",
      "senderPhone",
      "fromNumber",
      "data.from",
      "data.sender",
      "data.senderPhone",
      "message.from"
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
  const quotedMessageId = firstStringFromSources([messagePayload, rawPayload], [
    "message.extendedTextMessage.contextInfo.stanzaId",
    "extendedTextMessage.contextInfo.stanzaId",
    "contextInfo.stanzaId",
    "quotedMessageId",
    "quoted_message_id",
    "data.quotedMessageId",
    "data.quoted_message_id",
    "data.messages.message.extendedTextMessage.contextInfo.stanzaId"
  ]);
  const fromMe = firstBoolean(messagePayload, ["key.fromMe", "fromMe"]);
  const rawMessage =
    messagePayload && typeof messagePayload === "object"
      ? (messagePayload as Record<string, unknown>)
      : rawPayload;

  return {
    event,
    sessionId,
    from,
    senderPhone: phoneIdentity.phone,
    senderPhoneSource: phoneIdentity.source,
    senderLid,
    senderAddress,
    addressingMode,
    hasCleanedParticipantPn: Boolean(cleanedParticipantPn),
    hasCleanedSenderPn: Boolean(cleanedSenderPn),
    hasSenderPn: Boolean(senderPn),
    message: message ?? "",
    messageType: detectMessageType(messagePayload ?? rawPayload, message),
    mediaUrl,
    messageId,
    quotedMessageId,
    receiver: receiver || undefined,
    fromMe,
    rawMessage,
    rawPayload
  };
};
