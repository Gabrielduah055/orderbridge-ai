import { BadRequestError } from "./httpErrors";

interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const getLocalDateTimeParts = (
  value: Date,
  timezone: string
): LocalDateTimeParts => {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    })
      .formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  ) as Record<string, number>;

  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second
  };
};

const sameLocalDateTime = (
  left: LocalDateTimeParts,
  right: LocalDateTimeParts
): boolean =>
  left.year === right.year &&
  left.month === right.month &&
  left.day === right.day &&
  left.hour === right.hour &&
  left.minute === right.minute &&
  left.second === right.second;

export const resolveZonedDateTime = (
  value: string | Date | undefined,
  timezone: string,
  fieldName = "scheduledAt"
): Date | undefined => {
  if (!value) {
    return undefined;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new BadRequestError("Restaurant timezone is invalid");
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new BadRequestError(`Invalid ${fieldName}`);
    }

    return value;
  }

  if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestError(`Invalid ${fieldName}`);
    }

    return parsed;
  }

  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
  );

  if (!match) {
    throw new BadRequestError(
      `${fieldName} must be an ISO date-time or local YYYY-MM-DDTHH:mm`
    );
  }

  const target: LocalDateTimeParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0)
  };
  const targetTimestamp = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    target.second
  );
  let utcTimestamp = targetTimestamp;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = getLocalDateTimeParts(new Date(utcTimestamp), timezone);
    const observedTimestamp = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second
    );
    const adjustment = targetTimestamp - observedTimestamp;
    utcTimestamp += adjustment;

    if (adjustment === 0) {
      break;
    }
  }

  const resolved = new Date(utcTimestamp);

  if (
    Number.isNaN(resolved.getTime()) ||
    !sameLocalDateTime(getLocalDateTimeParts(resolved, timezone), target)
  ) {
    throw new BadRequestError(`Invalid ${fieldName} for restaurant timezone`);
  }

  return resolved;
};
