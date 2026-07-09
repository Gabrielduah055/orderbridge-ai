export const normalizeGhanaPhone = (phone: string): string => {
  const digits = phone.replace(/[^\d+]/g, "");

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
