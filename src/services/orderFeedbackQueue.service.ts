import { Types } from "mongoose";
import { OrderFeedback } from "../models/orderFeedback.model";
import { Order, type IOrderDocument } from "../models/order.model";
import { Restaurant, type IRestaurantDocument } from "../models/Restaurant";
import { normalizeGhanaPhone } from "../utils/phone.util";
import { feedbackCompletionEligibleStatuses } from "./orderCompletion.service";
import type { WasenderSendResult } from "./wasender.service";

export const ORDER_FEEDBACK_FOLLOW_UP_VERSION = 1;
export const DEFAULT_PICKUP_CHECK_IN_DELAY_MINUTES = 45;
export const DEFAULT_DELIVERY_CHECK_IN_DELAY_MINUTES = 75;
export const DEFAULT_ORDER_FEEDBACK_REMINDER_HOURS = 12;
export const DEFAULT_ORDER_AUTO_COMPLETE_HOURS = 24;

export interface OrderFeedbackEnqueueInput {
  restaurantId?: string;
  sessionId: string;
  to: string;
  type: "text" | "document";
  text?: string;
  apiKey?: string;
  idempotencyKey?: string;
  nextAttemptAt?: Date;
  metadata?: Record<string, unknown>;
}

export type OrderFeedbackEnqueue = (
  input: OrderFeedbackEnqueueInput
) => Promise<{ _id?: unknown }>;

export interface OrderFeedbackQueuedMessageView {
  restaurantId?: unknown;
  to: string;
  sessionId: string;
  apiKey?: string;
  metadata?: Record<string, unknown>;
}

export interface ScheduleOrderFeedbackDependencies {
  enqueueMessage: OrderFeedbackEnqueue;
}

export interface ScheduleOrderFeedbackResult {
  scheduled: boolean;
  idempotencyKey?: string;
  queueMessageId?: string;
  scheduledAt?: Date;
  reason?: string;
}

const parsePositiveNumber = (
  value: string | undefined,
  fallback: number
): number => {
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const getOrderCheckInDelayMinutes = (
  restaurant: Pick<
    IRestaurantDocument,
    "pickupCheckInDelayMinutes" | "deliveryCheckInDelayMinutes"
  >,
  orderType: IOrderDocument["orderType"]
): number => {
  const configured =
    orderType === "pickup"
      ? restaurant.pickupCheckInDelayMinutes
      : restaurant.deliveryCheckInDelayMinutes;

  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }

  return parsePositiveNumber(
    process.env.ORDER_FEEDBACK_DELAY_MINUTES,
    orderType === "pickup"
      ? DEFAULT_PICKUP_CHECK_IN_DELAY_MINUTES
      : DEFAULT_DELIVERY_CHECK_IN_DELAY_MINUTES
  );
};

export const getOrderFeedbackReminderHours = (): number =>
  parsePositiveNumber(
    process.env.ORDER_FEEDBACK_REMINDER_HOURS,
    DEFAULT_ORDER_FEEDBACK_REMINDER_HOURS
  );

export const getOrderAutoCompleteHours = (): number =>
  parsePositiveNumber(
    process.env.ORDER_AUTO_COMPLETE_HOURS,
    DEFAULT_ORDER_AUTO_COMPLETE_HOURS
  );

export const getOrderFeedbackReminderDelayMs = (): number => {
  const configuredMinutes = Number(process.env.ORDER_FEEDBACK_REMINDER_MINUTES);

  return Number.isFinite(configuredMinutes) && configuredMinutes > 0
    ? configuredMinutes * 60_000
    : getOrderFeedbackReminderHours() * 60 * 60_000;
};

export const getOrderAutoCompleteDelayMs = (): number => {
  const configuredMinutes = Number(process.env.ORDER_AUTO_COMPLETE_MINUTES);

  return Number.isFinite(configuredMinutes) && configuredMinutes > 0
    ? configuredMinutes * 60_000
    : getOrderAutoCompleteHours() * 60 * 60_000;
};

export const buildOrderFeedbackRequestMessage = (
  restaurant: Pick<IRestaurantDocument, "name">,
  order: Pick<IOrderDocument, "customerName" | "orderNumber" | "orderType" | "_id">
): string => {
  const customer = order.customerName?.trim();
  const greeting = customer ? `Hi ${customer} 👋` : "Hi there 👋";
  const orderNumber = order.orderNumber ?? String(order._id);
  const choices =
    order.orderType === "pickup"
      ? [
          "1. I picked it up and everything is fine",
          "2. I received it, but I have a complaint",
          "3. I haven't received/picked it up yet"
        ]
      : [
          "1. Received and satisfied",
          "2. Received, but I have a complaint",
          "3. I have not received it"
        ];

  return [
    greeting,
    "",
    `Just checking on order ${orderNumber} from ${restaurant.name}.`,
    "",
    ...choices,
    "",
    "You can also type your feedback."
  ].join("\n");
};

export const buildOrderFeedbackReminderMessage = (
  restaurant: Pick<IRestaurantDocument, "name">,
  order: Pick<IOrderDocument, "orderNumber" | "orderType" | "_id">
): string => {
  const orderNumber = order.orderNumber ?? String(order._id);
  const pendingText =
    order.orderType === "pickup"
      ? "3 if you have not received or picked it up yet"
      : "3 if you have not received it";

  return `One quick check-in on order ${orderNumber} from ${restaurant.name}: reply 1 if everything is fine, 2 for a complaint, or ${pendingText}.`;
};

export const buildOrderFeedbackQueueMetadata = (
  order: Pick<
    IOrderDocument,
    "_id" | "restaurantId" | "orderNumber" | "customerPhone"
  >,
  kind: "order_feedback_request" | "order_feedback_reminder",
  followUpVersion = ORDER_FEEDBACK_FOLLOW_UP_VERSION
): Record<string, unknown> => ({
  kind,
  restaurantId: String(order.restaurantId),
  orderId: String(order._id),
  orderNumber: order.orderNumber ?? String(order._id),
  customerPhone: normalizeGhanaPhone(order.customerPhone),
  followUpVersion,
  purpose: "transactional"
});

export const getOrderFeedbackFollowUpIdempotencyKey = (
  orderId: string,
  followUpVersion = ORDER_FEEDBACK_FOLLOW_UP_VERSION
): string => `order-feedback-follow-up:${orderId}:v${followUpVersion}`;

export const getOrderFeedbackReminderIdempotencyKey = (
  orderId: string,
  followUpVersion = ORDER_FEEDBACK_FOLLOW_UP_VERSION
): string => `order-feedback-reminder:${orderId}:v${followUpVersion}`;

const loadActiveRestaurant = async (
  restaurantId: string
): Promise<IRestaurantDocument | null> => {
  return Restaurant.findOne({
    _id: restaurantId,
    status: { $in: ["trial", "active"] }
  }).select("+wasenderApiToken");
};

export const scheduleOrderFeedbackFollowUp = async (
  restaurantId: string,
  orderId: string,
  dependencies: ScheduleOrderFeedbackDependencies,
  now = new Date()
): Promise<ScheduleOrderFeedbackResult> => {
  if (!Types.ObjectId.isValid(restaurantId) || !Types.ObjectId.isValid(orderId)) {
    return { scheduled: false, reason: "invalid_scope" };
  }

  const [restaurant, order] = await Promise.all([
    loadActiveRestaurant(restaurantId),
    Order.findOne({ _id: orderId, restaurantId })
  ]);

  if (!restaurant) {
    return { scheduled: false, reason: "restaurant_inactive_or_missing" };
  }

  if (!order) {
    return { scheduled: false, reason: "order_missing" };
  }

  if (!feedbackCompletionEligibleStatuses.includes(order.status)) {
    return { scheduled: false, reason: `order_${order.status}` };
  }

  if (restaurant.orderCheckInEnabled === false) {
    return { scheduled: false, reason: "order_check_in_disabled" };
  }

  if (!order.customerConfirmedNotificationSentAt && !order.receiptSentAt) {
    return { scheduled: false, reason: "acceptance_message_not_sent" };
  }

  if (
    order.feedbackReceivedAt ||
    ["answered", "issue_reported", "cancelled", "automatically_closed"].includes(
      order.feedbackFollowUpStatus
    )
  ) {
    return { scheduled: false, reason: "follow_up_no_longer_active" };
  }

  const customerPhone = normalizeGhanaPhone(order.customerPhone);

  if (!/^\+[1-9]\d{7,14}$/.test(customerPhone)) {
    return { scheduled: false, reason: "invalid_customer_phone" };
  }

  if (
    !restaurant.wasenderSessionId?.trim() ||
    !restaurant.wasenderApiToken?.trim()
  ) {
    return { scheduled: false, reason: "wasender_credentials_missing" };
  }

  const followUpVersion = ORDER_FEEDBACK_FOLLOW_UP_VERSION;
  const idempotencyKey = getOrderFeedbackFollowUpIdempotencyKey(
    orderId,
    followUpVersion
  );
  const acceptanceAnchor =
    order.customerConfirmedNotificationSentAt ?? order.receiptSentAt!;
  const scheduledAt =
    order.feedbackFollowUpScheduledAt ??
    new Date(
      acceptanceAnchor.getTime() +
        getOrderCheckInDelayMinutes(restaurant, order.orderType) * 60_000
    );
  const queued = await dependencies.enqueueMessage({
    restaurantId,
    sessionId: restaurant.wasenderSessionId,
    to: customerPhone,
    type: "text",
    text: buildOrderFeedbackRequestMessage(restaurant, order),
    apiKey: restaurant.wasenderApiToken,
    idempotencyKey,
    nextAttemptAt: scheduledAt,
    metadata: buildOrderFeedbackQueueMetadata(
      order,
      "order_feedback_request",
      followUpVersion
    )
  });

  await Order.updateOne(
    {
      _id: orderId,
      restaurantId,
      feedbackReceivedAt: { $exists: false },
      $or: [
        {
          feedbackFollowUpStatus: {
            $in: ["not_scheduled", "scheduled"]
          }
        },
        { feedbackFollowUpStatus: { $exists: false } }
      ]
    },
    {
      $set: {
        feedbackFollowUpScheduledAt: scheduledAt,
        feedbackRequestedAt: order.feedbackRequestedAt ?? now,
        feedbackFollowUpStatus: "scheduled",
        feedbackFollowUpVersion: followUpVersion
      }
    }
  );

  return {
    scheduled: true,
    idempotencyKey,
    queueMessageId: queued._id ? String(queued._id) : undefined,
    scheduledAt
  };
};

const getMetadataString = (
  metadata: Record<string, unknown> | undefined,
  key: string
): string => (typeof metadata?.[key] === "string" ? String(metadata[key]) : "");

export const getQueuedOrderFeedbackStaleReason = async (
  message: OrderFeedbackQueuedMessageView
): Promise<string | null> => {
  const kind = getMetadataString(message.metadata, "kind");

  if (kind !== "order_feedback_request" && kind !== "order_feedback_reminder") {
    return null;
  }

  const restaurantId = getMetadataString(message.metadata, "restaurantId");
  const orderId = getMetadataString(message.metadata, "orderId");
  const orderNumber = getMetadataString(message.metadata, "orderNumber");
  const purpose = getMetadataString(message.metadata, "purpose");
  const customerPhone = normalizeGhanaPhone(
    getMetadataString(message.metadata, "customerPhone")
  );
  const followUpVersion = Number(message.metadata?.followUpVersion);

  if (
    !Types.ObjectId.isValid(restaurantId) ||
    !Types.ObjectId.isValid(orderId) ||
    !orderNumber ||
    purpose !== "transactional" ||
    !/^\+[1-9]\d{7,14}$/.test(customerPhone) ||
    !Number.isInteger(followUpVersion) ||
    followUpVersion < 1
  ) {
    return "invalid_metadata";
  }

  if (
    message.restaurantId &&
    String(message.restaurantId) !== restaurantId
  ) {
    return "restaurant_scope_changed";
  }

  if (normalizeGhanaPhone(message.to) !== customerPhone) {
    return "customer_phone_changed";
  }

  const [restaurant, order] = await Promise.all([
    loadActiveRestaurant(restaurantId),
    Order.findOne({ _id: orderId, restaurantId }).select(
      "status orderNumber customerPhone feedbackFollowUpStatus feedbackFollowUpVersion feedbackReceivedAt feedbackRequestSentAt feedbackReminderSentAt"
    )
  ]);

  if (!restaurant) {
    return "restaurant_inactive_or_missing";
  }

  if (restaurant.wasenderSessionId !== message.sessionId) {
    return "restaurant_wasender_session_changed";
  }

  if (message.apiKey && restaurant.wasenderApiToken !== message.apiKey) {
    return "restaurant_wasender_token_changed";
  }

  if (!order) {
    return "order_missing";
  }

  if (!feedbackCompletionEligibleStatuses.includes(order.status)) {
    return `order_${order.status}`;
  }

  if ((order.orderNumber ?? String(order._id)) !== orderNumber) {
    return "order_number_changed";
  }

  if (normalizeGhanaPhone(order.customerPhone) !== customerPhone) {
    return "order_customer_phone_changed";
  }

  if (order.feedbackFollowUpVersion !== followUpVersion) {
    return "follow_up_version_changed";
  }

  if (order.feedbackReceivedAt) {
    return "feedback_already_received";
  }

  if (order.feedbackFollowUpStatus === "issue_reported") {
    return "delivery_issue_reported";
  }

  if (
    await OrderFeedback.exists({
      restaurantId,
      orderId,
      type: "delivery_not_received",
      resolvedAt: { $exists: false }
    })
  ) {
    return "unresolved_delivery_not_received";
  }

  if (kind === "order_feedback_request") {
    if (order.feedbackFollowUpStatus !== "scheduled") {
      return `follow_up_${order.feedbackFollowUpStatus}`;
    }

    return order.feedbackRequestSentAt ? "feedback_request_already_sent" : null;
  }

  if (order.feedbackFollowUpStatus !== "requested") {
    return `follow_up_${order.feedbackFollowUpStatus}`;
  }

  if (!order.feedbackRequestSentAt) {
    return "feedback_request_not_sent";
  }

  return order.feedbackReminderSentAt ? "feedback_reminder_already_sent" : null;
};

const getWasenderError = (result: WasenderSendResult): string =>
  result.error ||
  (result.status ? `Wasender status ${result.status}` : "Wasender send failed");

export const applyOrderFeedbackProviderResult = async (
  message: OrderFeedbackQueuedMessageView,
  result: WasenderSendResult,
  now = new Date()
): Promise<void> => {
  const kind = getMetadataString(message.metadata, "kind");
  const restaurantId = getMetadataString(message.metadata, "restaurantId");

  if (!Types.ObjectId.isValid(restaurantId)) {
    return;
  }

  if (kind === "order_feedback_owner_notification") {
    const feedbackId = getMetadataString(message.metadata, "feedbackId");

    if (!Types.ObjectId.isValid(feedbackId)) {
      return;
    }

    await OrderFeedback.updateOne(
      { _id: feedbackId, restaurantId },
      result.success
        ? {
            $set: { ownerNotifiedAt: now },
            $unset: {
              ownerNotificationFailedAt: "",
              ownerNotificationFailureReason: ""
            }
          }
        : {
            $set: {
              ownerNotificationFailedAt: now,
              ownerNotificationFailureReason: getWasenderError(result)
            }
          }
    );
    return;
  }

  if (kind !== "order_feedback_request" && kind !== "order_feedback_reminder") {
    return;
  }

  const orderId = getMetadataString(message.metadata, "orderId");
  const followUpVersion = Number(message.metadata?.followUpVersion);

  if (!Types.ObjectId.isValid(orderId) || !Number.isInteger(followUpVersion)) {
    return;
  }

  if (!result.success) {
    return;
  }

  await Order.updateOne(
    {
      _id: orderId,
      restaurantId,
      feedbackFollowUpVersion: followUpVersion,
      feedbackReceivedAt: { $exists: false }
    },
    kind === "order_feedback_request"
      ? {
          $set: {
            feedbackRequestSentAt: now,
            feedbackFollowUpStatus: "requested"
          }
        }
      : {
          $set: {
            feedbackReminderSentAt: now
          }
        }
  );
};
