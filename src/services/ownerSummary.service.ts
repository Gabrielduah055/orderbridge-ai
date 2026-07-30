import {
  Order,
  orderStatuses,
  type IOrderDocument,
  type OrderStatus
} from "../models/order.model";
import { ownerSummaryWeekdays, type OwnerSummaryWeekday } from "../types/restaurant.types";
import { normalizeGhanaPhone } from "../utils/phone.util";

export type OwnerSummaryPeriodType = "daily" | "weekly" | "custom";

export interface OwnerSummaryPeriod {
  type: OwnerSummaryPeriodType;
  timezone: string;
  periodStart: Date;
  periodEnd: Date;
  key: string;
}

export interface OwnerSummaryTopItem {
  menuItemId?: string;
  name: string;
  quantity: number;
  revenue: number;
}

export interface OwnerSummaryBusiestDay {
  date: string;
  day: OwnerSummaryWeekday;
  totalOrders: number;
}

export interface OwnerSummaryMetrics {
  restaurantId: string;
  periodType: OwnerSummaryPeriodType;
  periodStart: Date;
  periodEnd: Date;
  timezone: string;
  totalOrders: number;
  countsByStatus: Record<OrderStatus, number>;
  completedOrders: number;
  cancelledOrders: number;
  completedRevenue: number;
  averageCompletedOrderValue: number;
  topSellingItems: OwnerSummaryTopItem[];
  uniqueCustomers: number;
  newCustomers: number;
  returningCustomers: number;
  busiestDay: OwnerSummaryBusiestDay | null;
}

export interface GetOwnerSummaryMetricsInput {
  restaurantId: string;
  periodStart: Date;
  periodEnd: Date;
  timezone?: string;
  periodType?: OwnerSummaryPeriodType;
}

type SummaryOrder = Pick<
  IOrderDocument,
  "status" | "total" | "customerPhone" | "items" | "createdAt"
>;

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
}

interface ZonedDateTimeParts extends LocalDateParts {
  hour: number;
  minute: number;
  second: number;
}

const DEFAULT_TIMEZONE = "Africa/Accra";
const zonedFormatterCache = new Map<string, Intl.DateTimeFormat>();

const roundCurrency = (value: number): number =>
  Math.round((value + Number.EPSILON) * 100) / 100;

const padDatePart = (value: number): string => String(value).padStart(2, "0");

const localDateKey = (parts: LocalDateParts): string =>
  `${parts.year}-${padDatePart(parts.month)}-${padDatePart(parts.day)}`;

const shiftLocalDate = (parts: LocalDateParts, days: number): LocalDateParts => {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate()
  };
};

const getWeekday = (parts: LocalDateParts): OwnerSummaryWeekday => {
  const index = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return ownerSummaryWeekdays[index];
};

export const isValidOwnerSummaryTimezone = (timezone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
};

export const getZonedDateTimeParts = (
  value: Date,
  timezone = DEFAULT_TIMEZONE
): ZonedDateTimeParts => {
  let formatter = zonedFormatterCache.get(timezone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    });
    zonedFormatterCache.set(timezone, formatter);
  }

  const parts = Object.fromEntries(
    formatter
      .formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  ) as Record<string, number>;

  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second
  };
};

const localMidnightToUtc = (
  localDate: LocalDateParts,
  timezone: string
): Date => {
  const targetTimestamp = Date.UTC(
    localDate.year,
    localDate.month - 1,
    localDate.day,
    0,
    0,
    0
  );
  let utcTimestamp = targetTimestamp;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = getZonedDateTimeParts(new Date(utcTimestamp), timezone);
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

  return new Date(utcTimestamp);
};

const buildPeriod = (
  type: OwnerSummaryPeriodType,
  timezone: string,
  startLocalDate: LocalDateParts,
  endLocalDate: LocalDateParts
): OwnerSummaryPeriod => {
  const periodStart = localMidnightToUtc(startLocalDate, timezone);
  const periodEnd = localMidnightToUtc(endLocalDate, timezone);
  const key =
    type === "weekly"
      ? `${localDateKey(startLocalDate)}_to_${localDateKey(shiftLocalDate(endLocalDate, -1))}`
      : localDateKey(startLocalDate);

  return {
    type,
    timezone,
    periodStart,
    periodEnd,
    key
  };
};

export const getCurrentDailySummaryPeriod = (
  now = new Date(),
  timezone = DEFAULT_TIMEZONE
): OwnerSummaryPeriod => {
  const zonedNow = getZonedDateTimeParts(now, timezone);
  const startLocalDate: LocalDateParts = {
    year: zonedNow.year,
    month: zonedNow.month,
    day: zonedNow.day
  };

  return buildPeriod(
    "daily",
    timezone,
    startLocalDate,
    shiftLocalDate(startLocalDate, 1)
  );
};

export const getPreviousDailySummaryPeriod = (
  now = new Date(),
  timezone = DEFAULT_TIMEZONE
): OwnerSummaryPeriod => {
  const zonedNow = getZonedDateTimeParts(now, timezone);
  const endLocalDate: LocalDateParts = {
    year: zonedNow.year,
    month: zonedNow.month,
    day: zonedNow.day
  };

  return buildPeriod(
    "daily",
    timezone,
    shiftLocalDate(endLocalDate, -1),
    endLocalDate
  );
};

export const getPreviousWeeklySummaryPeriod = (
  now = new Date(),
  timezone = DEFAULT_TIMEZONE
): OwnerSummaryPeriod => {
  const zonedNow = getZonedDateTimeParts(now, timezone);
  const endLocalDate: LocalDateParts = {
    year: zonedNow.year,
    month: zonedNow.month,
    day: zonedNow.day
  };

  return buildPeriod(
    "weekly",
    timezone,
    shiftLocalDate(endLocalDate, -7),
    endLocalDate
  );
};

const getNormalizedCustomerPhones = (
  orders: Array<Pick<SummaryOrder, "customerPhone">>
): Set<string> => {
  const phones = new Set<string>();

  for (const order of orders) {
    const phone = normalizeGhanaPhone(order.customerPhone);

    if (phone) {
      phones.add(phone);
    }
  }

  return phones;
};

export const buildOwnerSummaryMetrics = (
  input: GetOwnerSummaryMetricsInput,
  periodOrders: SummaryOrder[],
  priorCustomerOrders: Array<Pick<SummaryOrder, "customerPhone">>
): OwnerSummaryMetrics => {
  const timezone = input.timezone ?? DEFAULT_TIMEZONE;
  const periodType = input.periodType ?? "custom";
  const countsByStatus = Object.fromEntries(
    orderStatuses.map((status) => [status, 0])
  ) as Record<OrderStatus, number>;

  for (const order of periodOrders) {
    countsByStatus[order.status] += 1;
  }

  const completedOrders = periodOrders.filter((order) => order.status === "completed");
  const completedRevenue = roundCurrency(
    completedOrders.reduce((sum, order) => sum + order.total, 0)
  );
  const itemTotals = new Map<string, OwnerSummaryTopItem>();

  for (const order of completedOrders) {
    for (const item of order.items) {
      const menuItemId = item.menuItemId ? String(item.menuItemId) : undefined;
      const key = menuItemId
        ? `id:${menuItemId}`
        : `name:${item.name.trim().replace(/\s+/g, " ").toLowerCase()}`;
      const current = itemTotals.get(key) ?? {
        menuItemId,
        name: item.name,
        quantity: 0,
        revenue: 0
      };

      current.quantity += item.quantity;
      current.revenue = roundCurrency(current.revenue + item.totalPrice);
      itemTotals.set(key, current);
    }
  }

  const topSellingItems = Array.from(itemTotals.values())
    .sort(
      (first, second) =>
        second.quantity - first.quantity ||
        second.revenue - first.revenue ||
        first.name.localeCompare(second.name)
    )
    .slice(0, 5);
  const periodCustomers = getNormalizedCustomerPhones(periodOrders);
  const priorCustomers = getNormalizedCustomerPhones(priorCustomerOrders);
  let returningCustomers = 0;

  for (const phone of periodCustomers) {
    if (priorCustomers.has(phone)) {
      returningCustomers += 1;
    }
  }

  const ordersByDay = new Map<string, OwnerSummaryBusiestDay>();

  if (periodType === "weekly") {
    for (const order of periodOrders) {
      const localDate = getZonedDateTimeParts(order.createdAt, timezone);
      const date = localDateKey(localDate);
      const current = ordersByDay.get(date) ?? {
        date,
        day: getWeekday(localDate),
        totalOrders: 0
      };

      current.totalOrders += 1;
      ordersByDay.set(date, current);
    }
  }

  const busiestDay =
    Array.from(ordersByDay.values()).sort(
      (first, second) =>
        second.totalOrders - first.totalOrders ||
        first.date.localeCompare(second.date)
    )[0] ?? null;

  return {
    restaurantId: input.restaurantId,
    periodType,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    timezone,
    totalOrders: periodOrders.length,
    countsByStatus,
    completedOrders: completedOrders.length,
    cancelledOrders: countsByStatus.cancelled,
    completedRevenue,
    averageCompletedOrderValue:
      completedOrders.length > 0
        ? roundCurrency(completedRevenue / completedOrders.length)
        : 0,
    topSellingItems,
    uniqueCustomers: periodCustomers.size,
    newCustomers: periodCustomers.size - returningCustomers,
    returningCustomers,
    busiestDay
  };
};

export const getOwnerSummaryMetrics = async (
  input: GetOwnerSummaryMetricsInput
): Promise<OwnerSummaryMetrics> => {
  if (!input.restaurantId.trim()) {
    throw new Error("restaurantId is required");
  }

  if (
    Number.isNaN(input.periodStart.getTime()) ||
    Number.isNaN(input.periodEnd.getTime()) ||
    input.periodStart >= input.periodEnd
  ) {
    throw new Error("periodStart must be before periodEnd");
  }

  const [periodOrders, priorCustomerOrders] = await Promise.all([
    Order.find({
      restaurantId: input.restaurantId,
      createdAt: {
        $gte: input.periodStart,
        $lt: input.periodEnd
      }
    }).select("status total customerPhone items createdAt"),
    Order.find({
      restaurantId: input.restaurantId,
      createdAt: {
        $lt: input.periodStart
      }
    }).select("customerPhone")
  ]);

  return buildOwnerSummaryMetrics(input, periodOrders, priorCustomerOrders);
};

const formatCurrency = (value: number): string => `GHS ${value.toFixed(2)}`;

const formatPeriodLabel = (period: OwnerSummaryPeriod): string => {
  const endInclusive = new Date(period.periodEnd.getTime() - 1);
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: period.timezone,
    day: "numeric",
    month: "short",
    year: "numeric"
  });
  const start = formatter.format(period.periodStart);
  const end = formatter.format(endInclusive);

  return start === end ? start : `${start} – ${end}`;
};

export const formatOwnerSummaryMessage = (
  restaurantName: string,
  period: OwnerSummaryPeriod,
  metrics: OwnerSummaryMetrics
): string => {
  const title = period.type === "weekly" ? "Weekly" : "Daily";
  const rejectedOrders = metrics.countsByStatus.rejected;
  const topItems =
    metrics.topSellingItems.length > 0
      ? metrics.topSellingItems
          .map(
            (item, index) =>
              `${index + 1}. ${item.name}: ${item.quantity} (${formatCurrency(item.revenue)})`
          )
          .join("\n")
      : "None";
  const busiestDayLine =
    period.type === "weekly" && metrics.busiestDay
      ? `\nBusiest day: ${metrics.busiestDay.date} (${metrics.busiestDay.totalOrders} orders)`
      : "";

  return [
    `${restaurantName} — ${title} summary`,
    formatPeriodLabel(period),
    `Orders: ${metrics.totalOrders} | Completed: ${metrics.completedOrders} | Cancelled: ${metrics.cancelledOrders} | Rejected: ${rejectedOrders}`,
    `Revenue: ${formatCurrency(metrics.completedRevenue)} | Average: ${formatCurrency(metrics.averageCompletedOrderValue)}`,
    `Customers: ${metrics.uniqueCustomers} | New: ${metrics.newCustomers} | Returning: ${metrics.returningCustomers}${busiestDayLine}`,
    `Top items:\n${topItems}`
  ].join("\n");
};
