import { OutboundMessage } from "../models/outboundMessage.model";
import { Restaurant, type IRestaurantDocument } from "../models/Restaurant";
import { ownerSummaryWeekdays, type OwnerSummaryWeekday } from "../types/restaurant.types";
import { normalizeGhanaPhone } from "../utils/phone.util";
import {
  formatOwnerSummaryMessage,
  getOwnerSummaryMetrics,
  getPreviousDailySummaryPeriod,
  getPreviousWeeklySummaryPeriod,
  getZonedDateTimeParts,
  type OwnerSummaryMetrics,
  type OwnerSummaryPeriod,
  type OwnerSummaryPeriodType
} from "./ownerSummary.service";
import {
  enqueueWasenderMessage,
  type EnqueueWasenderMessageInput
} from "./wasenderQueue.service";

const OWNER_SUMMARY_CHECK_INTERVAL_MS = 60_000;
const DEFAULT_TIMEZONE = "Africa/Accra";
const DEFAULT_SUMMARY_TIME = "08:00";
let schedulerStarted = false;
let schedulerBusy = false;

export type OwnerSummaryRestaurant = Pick<
  IRestaurantDocument,
  | "_id"
  | "name"
  | "ownerPhone"
  | "wasenderSessionId"
  | "wasenderApiToken"
  | "timezone"
  | "ownerDailySummaryEnabled"
  | "ownerDailySummaryTime"
  | "ownerWeeklySummaryEnabled"
  | "ownerWeeklySummaryDay"
  | "ownerWeeklySummaryTime"
>;

export interface OwnerSummarySchedulerDependencies {
  loadRestaurants?: () => Promise<OwnerSummaryRestaurant[]>;
  getMetrics?: typeof getOwnerSummaryMetrics;
  summaryExists?: (restaurantId: string, idempotencyKey: string) => Promise<boolean>;
  enqueueMessage?: (
    input: EnqueueWasenderMessageInput
  ) => Promise<{ _id?: unknown }>;
  logError?: (
    message: string,
    context: Record<string, unknown>
  ) => void;
}

export interface OwnerSummarySchedulerPassResult {
  restaurantsChecked: number;
  summariesQueued: number;
  errors: number;
}

const loadEligibleRestaurants = async (): Promise<OwnerSummaryRestaurant[]> => {
  return Restaurant.find({
    status: { $in: ["trial", "active"] },
    ownerPhone: { $exists: true, $ne: "" },
    wasenderSessionId: { $exists: true, $ne: "" },
    wasenderApiToken: { $exists: true, $ne: "" },
    $or: [
      { ownerDailySummaryEnabled: true },
      { ownerWeeklySummaryEnabled: true }
    ]
  }).select("+wasenderApiToken");
};

const defaultSummaryExists = async (
  restaurantId: string,
  idempotencyKey: string
): Promise<boolean> => {
  const existing = await OutboundMessage.exists({
    restaurantId,
    idempotencyKey
  });

  return Boolean(existing);
};

const parseScheduledTime = (time: string): { hour: number; minute: number } => {
  const match = /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(time);

  if (!match) {
    throw new Error(`Invalid owner summary time: ${time}`);
  }

  const [hour, minute] = time.split(":").map(Number);
  return { hour, minute };
};

export const isOwnerSummaryScheduleDue = (
  now: Date,
  timezone: string,
  time: string,
  day?: OwnerSummaryWeekday
): boolean => {
  const localNow = getZonedDateTimeParts(now, timezone);

  if (day) {
    const weekdayIndex = new Date(
      Date.UTC(localNow.year, localNow.month - 1, localNow.day)
    ).getUTCDay();

    if (ownerSummaryWeekdays[weekdayIndex] !== day) {
      return false;
    }
  }

  const scheduled = parseScheduledTime(time);
  return localNow.hour * 60 + localNow.minute >= scheduled.hour * 60 + scheduled.minute;
};

const getPeriodForType = (
  type: Exclude<OwnerSummaryPeriodType, "custom">,
  now: Date,
  timezone: string
): OwnerSummaryPeriod => {
  return type === "daily"
    ? getPreviousDailySummaryPeriod(now, timezone)
    : getPreviousWeeklySummaryPeriod(now, timezone);
};

const getOwnerSummaryIdempotencyKey = (
  restaurantId: string,
  period: OwnerSummaryPeriod
): string => {
  return `owner-summary:${period.type}:${restaurantId}:${period.key}`;
};

const enqueueSummaryForPeriod = async (
  restaurant: OwnerSummaryRestaurant,
  period: OwnerSummaryPeriod,
  dependencies: Required<
    Pick<
      OwnerSummarySchedulerDependencies,
      "getMetrics" | "summaryExists" | "enqueueMessage"
    >
  >
): Promise<boolean> => {
  const restaurantId = String(restaurant._id);
  const idempotencyKey = getOwnerSummaryIdempotencyKey(restaurantId, period);

  if (await dependencies.summaryExists(restaurantId, idempotencyKey)) {
    return false;
  }

  const metrics: OwnerSummaryMetrics = await dependencies.getMetrics({
    restaurantId,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    timezone: period.timezone,
    periodType: period.type
  });
  const queued = await dependencies.enqueueMessage({
    restaurantId,
    sessionId: restaurant.wasenderSessionId,
    to: normalizeGhanaPhone(restaurant.ownerPhone),
    type: "text",
    text: formatOwnerSummaryMessage(restaurant.name, period, metrics),
    apiKey: restaurant.wasenderApiToken,
    idempotencyKey,
    metadata: {
      kind: "owner_summary",
      summaryType: period.type,
      restaurantId,
      period: period.key,
      periodStart: period.periodStart.toISOString(),
      periodEnd: period.periodEnd.toISOString(),
      recipientType: "owner"
    }
  });

  console.info("Owner summary queued", {
    restaurantId,
    summaryType: period.type,
    period: period.key,
    queueMessageId: queued._id ? String(queued._id) : undefined
  });
  return true;
};

export const runOwnerSummarySchedulerPass = async (
  now = new Date(),
  dependencies: OwnerSummarySchedulerDependencies = {}
): Promise<OwnerSummarySchedulerPassResult> => {
  const loadRestaurants = dependencies.loadRestaurants ?? loadEligibleRestaurants;
  const getMetrics = dependencies.getMetrics ?? getOwnerSummaryMetrics;
  const summaryExists = dependencies.summaryExists ?? defaultSummaryExists;
  const enqueueMessage = dependencies.enqueueMessage ?? enqueueWasenderMessage;
  const logError =
    dependencies.logError ??
    ((message: string, context: Record<string, unknown>) =>
      console.error(message, context));
  const restaurants = await loadRestaurants();
  const result: OwnerSummarySchedulerPassResult = {
    restaurantsChecked: restaurants.length,
    summariesQueued: 0,
    errors: 0
  };

  for (const restaurant of restaurants) {
    const restaurantId = String(restaurant._id);
    const timezone = restaurant.timezone || DEFAULT_TIMEZONE;
    const schedules: Array<{
      type: "daily" | "weekly";
      enabled: boolean;
      time: string;
      day?: OwnerSummaryWeekday;
    }> = [
      {
        type: "daily",
        enabled: restaurant.ownerDailySummaryEnabled,
        time: restaurant.ownerDailySummaryTime || DEFAULT_SUMMARY_TIME
      },
      {
        type: "weekly",
        enabled: restaurant.ownerWeeklySummaryEnabled,
        time: restaurant.ownerWeeklySummaryTime || DEFAULT_SUMMARY_TIME,
        day: restaurant.ownerWeeklySummaryDay || "monday"
      }
    ];

    for (const schedule of schedules) {
      if (
        !schedule.enabled ||
        !isOwnerSummaryScheduleDue(now, timezone, schedule.time, schedule.day)
      ) {
        continue;
      }

      try {
        const period = getPeriodForType(schedule.type, now, timezone);
        const queued = await enqueueSummaryForPeriod(restaurant, period, {
          getMetrics,
          summaryExists,
          enqueueMessage
        });

        if (queued) {
          result.summariesQueued += 1;
        }
      } catch (error) {
        result.errors += 1;
        logError("Owner summary processing failed", {
          restaurantId,
          summaryType: schedule.type,
          error: error instanceof Error ? error.message : "Unknown owner summary error"
        });
      }
    }
  }

  return result;
};

export const startOwnerSummaryScheduler = (): void => {
  if (schedulerStarted) {
    return;
  }

  schedulerStarted = true;
  console.log(
    `[ownerSummary] Scheduler started (check every ${OWNER_SUMMARY_CHECK_INTERVAL_MS / 1000}s)`
  );

  const runPass = (): void => {
    if (schedulerBusy) {
      return;
    }

    schedulerBusy = true;
    void runOwnerSummarySchedulerPass()
      .catch((error) => {
        console.error("Owner summary scheduler pass failed", {
          error: error instanceof Error ? error.message : "Unknown owner summary scheduler error"
        });
      })
      .finally(() => {
        schedulerBusy = false;
      });
  };

  runPass();
  const timer = setInterval(runPass, OWNER_SUMMARY_CHECK_INTERVAL_MS);
  timer.unref?.();
};
