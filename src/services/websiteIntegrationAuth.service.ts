import { createHash, timingSafeEqual } from "crypto";

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
