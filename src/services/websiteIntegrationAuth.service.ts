import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";

const conversationTokenVersion = "v1";
const conversationIdPattern = /^[A-Za-z0-9_-]{43}$/;

export interface WebsiteConversationIdentity {
  conversationId: string;
  conversationToken: string;
}

export const hashWebsiteIntegrationKey = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export const verifyWebsiteIntegrationKey = (
  providedKey: string | undefined,
  expectedHash: string | undefined
): boolean => {
  if (!providedKey?.trim() || !expectedHash?.trim()) {
    return false;
  }

  const providedHash = Buffer.from(hashWebsiteIntegrationKey(providedKey.trim()), "hex");
  const expected = Buffer.from(expectedHash.trim(), "hex");

  return providedHash.length === expected.length && timingSafeEqual(providedHash, expected);
};

const buildWebsiteConversationToken = (
  businessId: string,
  conversationId: string,
  integrationKeyHash: string
): string => {
  const signature = createHmac("sha256", integrationKeyHash)
    .update(`${conversationTokenVersion}:${businessId}:${conversationId}`, "utf8")
    .digest("base64url");

  return `${conversationTokenVersion}.${signature}`;
};

export const createWebsiteConversationIdentity = (
  businessId: string,
  integrationKeyHash: string
): WebsiteConversationIdentity => {
  const conversationId = randomBytes(32).toString("base64url");

  return {
    conversationId,
    conversationToken: buildWebsiteConversationToken(
      businessId,
      conversationId,
      integrationKeyHash
    )
  };
};

export const verifyWebsiteConversationIdentity = (
  businessId: string,
  conversationId: string | undefined,
  conversationToken: string | undefined,
  integrationKeyHash: string | undefined
): boolean => {
  if (
    !conversationId ||
    !conversationToken ||
    !integrationKeyHash ||
    !conversationIdPattern.test(conversationId)
  ) {
    return false;
  }

  const expected = Buffer.from(
    buildWebsiteConversationToken(businessId, conversationId, integrationKeyHash),
    "utf8"
  );
  const provided = Buffer.from(conversationToken, "utf8");

  return provided.length === expected.length && timingSafeEqual(provided, expected);
};
