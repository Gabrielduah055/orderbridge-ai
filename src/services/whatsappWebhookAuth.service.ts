import { createHash, timingSafeEqual } from "crypto";

export const hashWhatsappWebhookSecret = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export const verifyWhatsappWebhookSecret = (
  providedSecret: string | undefined,
  expectedHash: string | undefined
): boolean => {
  if (!providedSecret?.trim() || !expectedHash?.trim()) return false;

  const provided = Buffer.from(
    hashWhatsappWebhookSecret(providedSecret.trim()),
    "hex"
  );
  const expected = Buffer.from(expectedHash.trim(), "hex");

  return provided.length === expected.length && timingSafeEqual(provided, expected);
};
