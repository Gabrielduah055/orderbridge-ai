export const normalizeWhatsappUsername = (value?: string): string => {
  if (!value) {
    return "";
  }

  const username = value.replace(/^whatsapp:/i, "").trim().toLowerCase();

  if (username === "@lid") {
    return "";
  }

  return /^@[a-z0-9._-]+$/i.test(username) ? username : "";
};

export const normalizeGhanaPhone = (phone: string): string => {
  const value = phone.trim();

  // Wasender accepts WhatsApp username handles wherever it accepts a phone
  // recipient. Preserve the handle as the stable customer address when the
  // account intentionally has no resolvable phone number.
  const username = normalizeWhatsappUsername(value);

  if (username) {
    return username;
  }

  // A WhatsApp LID is a provider address, not a phone number. Keeping this
  // guard at the shared normalization boundary prevents accidental callers
  // from converting privacy-addressed identities into fake customer phones.
  if (/@lid$/i.test(value)) {
    return "";
  }

  const phoneAddress = value
    .replace(/^whatsapp:/i, "")
    .replace(/@s\.whatsapp\.net$/i, "")
    .replace(/@c\.us$/i, "");

  if (phoneAddress.includes("@")) {
    return "";
  }

  const digits = phoneAddress.replace(/[^\d+]/g, "");

  if (digits.startsWith("+233")) {
    return digits;
  }

  if (digits.startsWith("233")) {
    return `+${digits}`;
  }

  if (digits.startsWith("0") && digits.length === 10) {
    return `+233${digits.slice(1)}`;
  }

  return digits;
};

export const normalizePhoneList = (phones: string[] = []): string[] => {
  return phones.map(normalizeGhanaPhone).filter(Boolean);
};
