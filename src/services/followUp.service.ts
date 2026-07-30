import { Restaurant } from "../models/Restaurant";
import { CustomerSession } from "../models/customerSession.model";
import { buildFollowUpKey, buildStateAwareFollowUpMessage } from "./orderDraft.service";
import { enqueueWasenderMessage } from "./wasenderQueue.service";

const DEFAULT_FOLLOW_UP_DELAY_MINUTES = 3;
const SCHEDULER_INTERVAL_MS = 60_000;

const activeSteps: string[] = [
  "collecting_quantity",
  "choosing_order_type",
  "selecting_item_from_category",
  "collecting_address",
  "collecting_name",
  "confirming_order"
];

const runFollowUpPass = async (): Promise<void> => {
  try {
    const restaurants = await Restaurant.find({
      followUpEnabled: true,
      wasenderSessionId: { $exists: true, $ne: "" },
      wasenderApiToken: { $exists: true, $ne: "" }
    }).select("_id followUpDelayMinutes wasenderSessionId wasenderApiToken");

    if (restaurants.length === 0) {
      return;
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
          metadata: {
            kind: "customer_follow_up",
            sessionId: String(session._id),
            followUpKey
          }
        });

        session.lastFollowUpKey = followUpKey;
        session.lastFollowUpAt = now;
        await session.save();
      } catch (sessionError) {
        console.error(
          `[followUp] Error processing session ${String(session._id)}:`,
          sessionError
        );
      }
    }
  } catch (error) {
    console.error("[followUp] Scheduler pass failed:", error);
  }
};

export const startFollowUpScheduler = (): void => {
  console.log(`[followUp] Follow-up scheduler started (check every ${SCHEDULER_INTERVAL_MS / 1000}s)`);
  void runFollowUpPass();
  setInterval(() => void runFollowUpPass(), SCHEDULER_INTERVAL_MS);
};
