const signedUrlPattern = /https?:\/\/[^\s"'<>]+/gi;

export const redactUrls = (value: string): string => {
  return value.replace(signedUrlPattern, "[redacted URL]");
};

const getObjectString = (
  value: Record<string, unknown>,
  key: string
): string | undefined => {
  const candidate = value[key];

  if (typeof candidate === "string" && candidate.trim()) {
    return candidate.trim();
  }

  if (candidate && typeof candidate === "object") {
    const nestedMessage = (candidate as Record<string, unknown>).message;

    if (typeof nestedMessage === "string" && nestedMessage.trim()) {
      return nestedMessage.trim();
    }
  }

  return undefined;
};

export const getSafeErrorMessage = (
  error: unknown,
  fallback = "The operation failed without an error message"
): string => {
  let message: string | undefined;

  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === "string") {
    message = error;
  } else if (error && typeof error === "object") {
    const objectError = error as Record<string, unknown>;
    message =
      getObjectString(objectError, "message") ??
      getObjectString(objectError, "error_description") ??
      getObjectString(objectError, "error");

    if (!message) {
      const code = objectError.code ?? objectError.http_code ?? objectError.status;

      if (typeof code === "string" || typeof code === "number") {
        message = `Request failed with code ${String(code)}`;
      }
    }
  }

  return redactUrls(message?.trim() || fallback);
};
