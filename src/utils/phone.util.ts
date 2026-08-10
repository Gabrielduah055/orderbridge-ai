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

export const normalizePhoneList = (phones: string[] = []): string[] => {
  return phones.map(normalizeGhanaPhone).filter(Boolean);
};
