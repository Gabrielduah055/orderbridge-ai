import { OutboundMessage } from "../models/outboundMessage.model";
import {
  PendingAgentAction,
  type IPendingAgentActionDocument
} from "../models/pendingAgentAction.model";
import { Restaurant, type IRestaurantDocument } from "../models/Restaurant";
import { normalizeGhanaPhone } from "../utils/phone.util";
import { resolveSenderIdentity } from "./senderIdentity.service";
import {
  enqueueWasenderMessage,
  type EnqueueWasenderMessageInput
} from "./wasenderQueue.service";

const REMINDER_CHECK_INTERVAL_MS = 60_000;
const DEFAULT_REMINDER_DELAY_MINUTES = 3;
let schedulerStarted = false;
let schedulerBusy = false;

export type OwnerPendingActionReminderRestaurant = Pick<
  IRestaurantDocument,
  | "_id"
  | "name"
  | "ownerName"
  | "ownerPhone"
  | "managerPhones"
  | "managerContacts"
  | "wasenderSessionId"
  | "wasenderApiToken"
  | "ownerPendingActionReminderEnabled"
  | "ownerPendingActionReminderDelayMinutes"
>;

export interface OwnerPendingActionReminderDependencies {
  loadRestaurants?: () => Promise<OwnerPendingActionReminderRestaurant[]>;
  findEligibleActions?: (
    restaurantId: string,
    now: Date,
    delayMinutes: number
  ) => Promise<IPendingAgentActionDocument[]>;
  rereadAction?: (
    restaurantId: string,
    pendingActionId: string
  ) => Promise<IPendingAgentActionDocument | null>;
  hasNewerPendingAction?: (
    restaurantId: string,
    action: IPendingAgentActionDocument,
    now: Date
  ) => Promise<boolean>;
  reminderExists?: (
    restaurantId: string,
    idempotencyKey: string
  ) => Promise<boolean>;
  enqueueMessage?: (
    input: EnqueueWasenderMessageInput
  ) => Promise<{ _id?: unknown }>;
  logError?: (
    message: string,
    context: Record<string, unknown>
  ) => void;
}

export interface OwnerPendingActionReminderPassResult {
  restaurantsChecked: number;
  actionsChecked: number;
  remindersQueued: number;
  errors: number;
}

const getActionVersion = (
  action: Pick<IPendingAgentActionDocument, "actionVersion">
): number => {
  return Number.isInteger(action.actionVersion) && action.actionVersion > 0
    ? action.actionVersion
    : 1;
};

const getActionLastChangedAt = (
  action: Pick<IPendingAgentActionDocument, "createdAt" | "updatedAt">
): Date => {
  return action.updatedAt ?? action.createdAt;
};

const loadEligibleRestaurants = async (): Promise<
  OwnerPendingActionReminderRestaurant[]
> => {
  return Restaurant.find({
    status: { $in: ["trial", "active"] },
    ownerPendingActionReminderEnabled: true,
    wasenderSessionId: { $exists: true, $ne: "" },
    wasenderApiToken: { $exists: true, $ne: "" }
  }).select("+wasenderApiToken");
};

export const findEligibleOwnerPendingActions = async (
  restaurantId: string,
  now: Date,
  delayMinutes: number
): Promise<IPendingAgentActionDocument[]> => {
  const cutoff = new Date(now.getTime() - delayMinutes * 60_000);

  return PendingAgentAction.find({
    restaurantId,
    status: "pending",
    action: { $ne: "MENU_ITEM_IMAGE_CONTEXT" },
    expiresAt: { $gt: now },
    updatedAt: { $lte: cutoff }
  }).sort({ updatedAt: 1, createdAt: 1 });
};

export const rereadOwnerPendingAction = async (
  restaurantId: string,
  pendingActionId: string
): Promise<IPendingAgentActionDocument | null> => {
  return PendingAgentAction.findOne({
    _id: pendingActionId,
    restaurantId
  });
};

export const hasNewerOwnerPendingAction = async (
  restaurantId: string,
  action: IPendingAgentActionDocument,
  now: Date
): Promise<boolean> => {
  const newerAction = await PendingAgentAction.exists({
    restaurantId,
    senderPhone: action.senderPhone,
    status: "pending",
    expiresAt: { $gt: now },
    createdAt: { $gt: action.createdAt }
  });

  return Boolean(newerAction);
};

const defaultReminderExists = async (
  restaurantId: string,
  idempotencyKey: string
): Promise<boolean> => {
  const existing = await OutboundMessage.exists({
    restaurantId,
    idempotencyKey
  });

  return Boolean(existing);
};

const compactBackendDetail = (value?: string): string | undefined => {
  const compact = value?.trim().replace(/\s+/g, " ");

  if (!compact) {
    return undefined;
  }

  return compact.length > 450 ? `${compact.slice(0, 447)}...` : compact;
};

const buildFallbackActionDetail = (
  action: IPendingAgentActionDocument
): string => {
  const data = action.arguments ?? action.data;

  if (action.action === "UPDATE_MENU_PRICE" || action.toolName === "update_menu_price") {
    const itemName = data.itemName ? String(data.itemName) : "the menu item";
    const price = data.newPrice ?? data.price;
    return price !== undefined
      ? `Change ${itemName} price to GHS ${Number(price).toFixed(2)}.`
      : `Change ${itemName}'s price.`;
  }

  if (
    action.action === "MARK_ITEM_AVAILABLE" ||
    action.action === "MARK_ITEM_UNAVAILABLE" ||
    action.toolName === "set_item_availability"
  ) {
    const itemName = data.itemName ? String(data.itemName) : "the menu item";
    const available =
      action.action === "MARK_ITEM_AVAILABLE" ||
      (action.action === "TOOL_CALL" && data.available === true);
    return `Mark ${itemName} as ${available ? "available" : "unavailable"}.`;
  }

  if (action.action === "ADD_MENU_ITEM" || action.toolName === "add_menu_items") {
    const itemCount = Array.isArray(data.items) ? data.items.length : 1;
    return `Add ${itemCount} pending menu item${itemCount === 1 ? "" : "s"}.`;
  }

  if (action.toolName === "cancel_order") {
    const reference = data.orderReference ?? data.orderId;
    return reference
      ? `Cancel order ${String(reference)}.`
      : "Cancel the pending order.";
  }

  return "Complete the pending restaurant action.";
};

export const buildOwnerPendingActionReminderMessage = (
  action: IPendingAgentActionDocument
): string => {
  if (action.action === "OWNER_ORDER_SELECTION") {
    const decision = action.data.decision === "reject" ? "reject" : "accept";
    return `Reminder: choose which pending order or orders to ${decision}. Reply with the requested order number(s), or reply cancel.`;
  }

  const detail =
    compactBackendDetail(action.summary) ??
    compactBackendDetail(action.confirmationMessage) ??
    buildFallbackActionDetail(action);

  return `Reminder: ${detail}\nReply confirm to proceed, or cancel to discard this pending action.`;
};

const isActionStillEligible = (
  action: IPendingAgentActionDocument,
  expectedVersion: number,
  now: Date,
  delayMinutes: number
): boolean => {
  const cutoff = new Date(now.getTime() - delayMinutes * 60_000);

  return (
    action.status === "pending" &&
    action.action !== "MENU_ITEM_IMAGE_CONTEXT" &&
    action.expiresAt > now &&
    getActionVersion(action) === expectedVersion &&
    getActionLastChangedAt(action) <= cutoff
  );
};

const getReminderIdempotencyKey = (
  restaurantId: string,
  pendingActionId: string,
  actionVersion: number
): string => {
  return `owner-action-reminder:${restaurantId}:${pendingActionId}:${actionVersion}`;
};

export const runOwnerPendingActionReminderPass = async (
  now = new Date(),
  dependencies: OwnerPendingActionReminderDependencies = {}
): Promise<OwnerPendingActionReminderPassResult> => {
  const loadRestaurants = dependencies.loadRestaurants ?? loadEligibleRestaurants;
  const findEligibleActions =
    dependencies.findEligibleActions ?? findEligibleOwnerPendingActions;
  const rereadAction = dependencies.rereadAction ?? rereadOwnerPendingAction;
  const hasNewerPendingAction =
    dependencies.hasNewerPendingAction ?? hasNewerOwnerPendingAction;
  const reminderExists = dependencies.reminderExists ?? defaultReminderExists;
  const enqueueMessage = dependencies.enqueueMessage ?? enqueueWasenderMessage;
  const logError =
    dependencies.logError ??
    ((message: string, context: Record<string, unknown>) =>
      console.error(message, context));
  const restaurants = await loadRestaurants();
  const result: OwnerPendingActionReminderPassResult = {
    restaurantsChecked: restaurants.length,
    actionsChecked: 0,
    remindersQueued: 0,
    errors: 0
  };

  for (const restaurant of restaurants) {
    const restaurantId = String(restaurant._id);

    if (!restaurant.ownerPendingActionReminderEnabled) {
      continue;
    }

    const delayMinutes = Math.max(
      1,
      restaurant.ownerPendingActionReminderDelayMinutes ??
        DEFAULT_REMINDER_DELAY_MINUTES
    );
    let actions: IPendingAgentActionDocument[];

    try {
      actions = await findEligibleActions(restaurantId, now, delayMinutes);
    } catch (error) {
      result.errors += 1;
      logError("Owner pending-action reminder lookup failed", {
        restaurantId,
        error: error instanceof Error ? error.message : "Unknown pending-action lookup error"
      });
      continue;
    }

    for (const selectedAction of actions) {
      result.actionsChecked += 1;
      const pendingActionId = String(selectedAction._id);

      try {
        const selectedVersion = getActionVersion(selectedAction);
        const action = await rereadAction(restaurantId, pendingActionId);

        if (
          !action ||
          !isActionStillEligible(
            action,
            selectedVersion,
            now,
            delayMinutes
          )
        ) {
          continue;
        }

        if (
          action.senderRole &&
          action.senderRole !== "owner" &&
          action.senderRole !== "manager"
        ) {
          continue;
        }

        const sender = resolveSenderIdentity(restaurant, action.senderPhone);

        if (
          !sender.verified ||
          (sender.role !== "owner" && sender.role !== "manager")
        ) {
          continue;
        }

        if (await hasNewerPendingAction(restaurantId, action, now)) {
          continue;
        }

        const actionVersion = getActionVersion(action);
        const idempotencyKey = getReminderIdempotencyKey(
          restaurantId,
          pendingActionId,
          actionVersion
        );

        if (await reminderExists(restaurantId, idempotencyKey)) {
          continue;
        }

        const queued = await enqueueMessage({
          restaurantId,
          sessionId: restaurant.wasenderSessionId,
          to: sender.normalizedPhone,
          type: "text",
          text: buildOwnerPendingActionReminderMessage(action),
          apiKey: restaurant.wasenderApiToken,
          idempotencyKey,
          metadata: {
            kind: "owner_action_reminder",
            restaurantId,
            pendingActionId,
            actionVersion,
            pendingActionPhone: sender.normalizedPhone,
            pendingActionCreatedAt: action.createdAt.toISOString(),
            action: action.action,
            toolName: action.toolName,
            recipientRole: sender.role
          }
        });

        result.remindersQueued += 1;
        console.info("Owner pending-action reminder queued", {
          restaurantId,
          pendingActionId,
          actionVersion,
          queueMessageId: queued._id ? String(queued._id) : undefined,
          recipientRole: sender.role
        });
      } catch (error) {
        result.errors += 1;
        logError("Owner pending-action reminder processing failed", {
          restaurantId,
          pendingActionId,
          error:
            error instanceof Error
              ? error.message
              : "Unknown pending-action reminder error"
        });
      }
    }
  }

  return result;
};

export const startOwnerPendingActionReminderScheduler = (): void => {
  if (schedulerStarted) {
    return;
  }

  schedulerStarted = true;
  console.log(
    `[ownerPendingActionReminder] Scheduler started (check every ${REMINDER_CHECK_INTERVAL_MS / 1000}s)`
  );

  const runPass = (): void => {
    if (schedulerBusy) {
      return;
    }

    schedulerBusy = true;
    void runOwnerPendingActionReminderPass()
      .catch((error) => {
        console.error("Owner pending-action reminder scheduler pass failed", {
          error:
            error instanceof Error
              ? error.message
              : "Unknown pending-action reminder scheduler error"
        });
      })
      .finally(() => {
        schedulerBusy = false;
      });
  };

  runPass();
  const timer = setInterval(runPass, REMINDER_CHECK_INTERVAL_MS);
  timer.unref?.();
};
