const DEFAULT_TIMEZONE = "Africa/Accra";

/**
 * Format a date as a human-readable date string in the restaurant's timezone.
 *
 * Example: "11 August 2026"
 */
export const formatDisplayDate = (
  value: Date,
  timezone = DEFAULT_TIMEZONE
): string => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    day: "numeric",
    month: "long",
    year: "numeric"
  }).formatToParts(value);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  ) as Record<string, string>;

  return `${values.day} ${values.month} ${values.year}`;
};

/**
 * Format a date as a human-readable date + time string in the restaurant's
 * timezone.
 *
 * Example: "11 August 2026 at 19:03"
 */
export const formatDisplayDateTime = (
  value: Date,
  timezone = DEFAULT_TIMEZONE
): string => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(value);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  ) as Record<string, string>;
  return `${values.day} ${values.month} ${values.year} at ${values.hour}:${values.minute}`;
};
