import { Restaurant } from "../models/Restaurant";
import {
  CustomerSession,
  type ICustomerSessionDocument
} from "../models/customerSession.model";
import { buildFollowUpKey, buildStateAwareFollowUpMessage } from "./orderDraft.service";
import { enqueueWasenderMessage } from "./wasenderQueue.service";

const DEFAULT_FOLLOW_UP_DELAY_MINUTES = 3;
const SCHEDULER_INTERVAL_MS = 60_000;
let schedulerStarted = false;
let schedulerBusy = false;
let schedulerPassLogged = false;

const activeSteps: string[] = [
  "collecting_quantity",
  "choosing_order_type",
  "selecting_item_from_category",
  "collecting_address",
  "collecting_name",
  "confirming_order"
];

export const buildCustomerFollowUpQueueMetadata = (
  session: Pick<
    ICustomerSessionDocument,
    "_id" | "restaurantId" | "customerPhone" | "conversationVersion" | "currentStep"
  >,
  followUpKey: string
): Record<string, unknown> => ({
  kind: "customer_follow_up",
  sessionId: String(session._id),
  restaurantId: String(session.restaurantId),
  customerPhone: session.customerPhone,
  conversationVersion: session.conversationVersion,
  expectedDraftStep: session.currentStep,
  followUpKey
});

export interface FollowUpSchedulerPassResult {
  eligibleRestaurants: number;
  sessionsChecked: number;
  messagesQueued: number;
  errors: number;
}

export const runFollowUpPass = async (): Promise<FollowUpSchedulerPassResult> => {
  const result: FollowUpSchedulerPassResult = {
    eligibleRestaurants: 0,
    sessionsChecked: 0,
    messagesQueued: 0,
    errors: 0
  };

  try {
    const restaurants = await Restaurant.find({
      followUpEnabled: { $ne: false },
      wasenderSessionId: { $exists: true, $ne: "" },
      wasenderApiToken: { $exists: true, $ne: "" }
    }).select("_id followUpDelayMinutes wasenderSessionId +wasenderApiToken");
    result.eligibleRestaurants = restaurants.length;

    if (restaurants.length === 0) {
      return result;
    }

    const restaurantMap = new Map(
      restaurants.map((r) => [String(r._id), r])
    );

    const now = new Date();

    const sessions = await CustomerSession.find({
      restaurantId: { $in: Array.from(restaurantMap.keys()) },
      currentStep: { $in: activeSteps },
      expiresAt: { $gt: now }
    }).select(
      "_id restaurantId customerPhone currentStep conversationVersion lastFollowUpKey lastFollowUpAt expiresAt"
    );

    for (const session of sessions) {
      result.sessionsChecked += 1;

      try {
        const restaurant = restaurantMap.get(String(session.restaurantId));

        if (!restaurant) {
          continue;
        }

        const delayMinutes = restaurant.followUpDelayMinutes ?? DEFAULT_FOLLOW_UP_DELAY_MINUTES;
        const delayMs = delayMinutes * 60 * 1000;
        const sessionTtlMs = 2 * 60 * 60 * 1000;
        const lastTouched = new Date(session.expiresAt.getTime() - sessionTtlMs);
        const idleMs = now.getTime() - lastTouched.getTime();

        if (idleMs < delayMs) {
          continue;
        }

        const followUpKey = buildFollowUpKey(session);

        if (session.lastFollowUpKey === followUpKey) {
          continue;
        }

        const message = buildStateAwareFollowUpMessage(session.currentStep);

        if (!message) {
          continue;
        }

        const idempotencyKey = `followup:${String(session._id)}:${followUpKey}`;

        await enqueueWasenderMessage({
          restaurantId: String(session.restaurantId),
          sessionId: restaurant.wasenderSessionId,
          to: session.customerPhone,
          type: "text",
          text: message,
          apiKey: restaurant.wasenderApiToken,
          idempotencyKey,
          metadata: buildCustomerFollowUpQueueMetadata(session, followUpKey)
        });

        session.lastFollowUpKey = followUpKey;
        session.lastFollowUpAt = now;
        await session.save();
        result.messagesQueued += 1;
      } catch (sessionError) {
        result.errors += 1;
        console.error(
          `[followUp] Error processing session ${String(session._id)}:`,
          sessionError
        );
      }
    }
  } catch (error) {
    result.errors += 1;
    console.error("[followUp] Scheduler pass failed:", error);
  }

  return result;
};

export const startFollowUpScheduler = (): void => {
  if (schedulerStarted) {
    return;
  }

  schedulerStarted = true;
  console.log(`[followUp] Follow-up scheduler started (check every ${SCHEDULER_INTERVAL_MS / 1000}s)`);

  const runPass = (): void => {
    if (schedulerBusy) {
      return;
    }

    schedulerBusy = true;
    void runFollowUpPass()
      .then((result) => {
        if (!schedulerPassLogged || result.messagesQueued > 0 || result.errors > 0) {
          console.info("[followUp] Scheduler pass", result);
          schedulerPassLogged = true;
        }
      })
      .finally(() => {
        schedulerBusy = false;
      });
  };

  runPass();
  const timer = setInterval(runPass, SCHEDULER_INTERVAL_MS);
  timer.unref?.();
};
