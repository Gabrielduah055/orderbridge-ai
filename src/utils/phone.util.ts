export const normalizeWhatsappUsername = (value?: string): string => {
  if (!value) {
    return "";
  }

  const username = value.replace(/^whatsapp:/i, "").trim().toLowerCase();
  const body = username.startsWith("@") ? username.slice(1) : "";

  if (
    username === "@lid" ||
    body.length < 3 ||
    body.length > 35 ||
    !/^[a-z0-9._]+$/.test(body) ||
    /^\d+$/.test(body)
  ) {
    return "";
  }

  return username;
};

export const normalizeGhanaPhone = (phone: string): string => {
  const value = phone.trim();

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

export const normalizeWhatsappRecipient = (value?: string): string => {
  if (!value) {
    return "";
  }

  return normalizeWhatsappUsername(value) || normalizeGhanaPhone(value);
};

export const isWhatsappPhoneAddress = (value?: string): boolean =>
  Boolean(value && /^\+[1-9]\d{7,14}$/.test(normalizeGhanaPhone(value)));

export const isWhatsappUsername = (value?: string): boolean =>
  Boolean(normalizeWhatsappUsername(value));

export const isValidWhatsappRecipient = (value?: string): boolean =>
  Boolean(normalizeWhatsappRecipient(value)) &&
  (isWhatsappUsername(value) || isWhatsappPhoneAddress(value));

export const normalizePhoneList = (phones: string[] = []): string[] => {
  return phones.map(normalizeGhanaPhone).filter(Boolean);
};
