import { Types } from "mongoose";
import { z } from "zod";
import {
  OrderFeedback,
  orderFeedbackSentiments,
  orderFeedbackTypes,
  type IOrderFeedbackDocument,
  type OrderFeedbackSentiment,
  type OrderFeedbackType
} from "../models/orderFeedback.model";
import { Order, type IOrderDocument } from "../models/order.model";
import { OutboundMessage } from "../models/outboundMessage.model";
import { Restaurant } from "../models/Restaurant";
import { BadRequestError, NotFoundError } from "../utils/httpErrors";
import { normalizeGhanaPhone } from "../utils/phone.util";
import { createAiProvider } from "./ai/aiProvider.factory";
import { getAiProviderName, getOpenRouterConfig } from "./ai/ai.config";
import { getEquivalentCustomerPhones } from "./customerProfile.service";
import {
  cancelQueuedOrderFeedbackMessages,
  completeOrderThroughFeedback,
  feedbackCompletionEligibleStatuses
} from "./orderCompletion.service";
import { enqueueWasenderMessage } from "./wasenderQueue.service";

export interface FeedbackClassification {
  type: OrderFeedbackType;
  sentiment: OrderFeedbackSentiment;
  rating?: number;
  requiresOwnerAttention: boolean;
  receiptStatus: "received" | "not_received" | "unclear";
  summary?: string;
}

export interface HandleOrderFeedbackResponseInput {
  restaurantId: string;
  customerPhone: string;
  customerName?: string;
  message: string;
  inboundEventId?: string;
  trustedOrderId?: string;
}

export interface HandleOrderFeedbackResponseResult {
  handled: boolean;
  success: boolean;
  message?: string;
  order?: IOrderDocument;
  feedback?: IOrderFeedbackDocument;
  ambiguousOrderNumbers?: string[];
}

export interface OrderFeedbackResponseDependencies {
  // Reserved for future dependency injection in tests.
}

export const orderCheckInOutcomes = [
  "received_satisfied",
  "received_complaint",
  "not_received"
] as const;

export type OrderCheckInOutcome = (typeof orderCheckInOutcomes)[number];

export interface RespondToOrderCheckInInput {
  restaurantId: string;
  customerPhone: string;
  customerName?: string;
  outcome: OrderCheckInOutcome;
  orderReference?: string;
  feedbackText?: string;
  inboundEventId?: string;
}

export interface ListCustomerFeedbackInput {
  type?: OrderFeedbackType;
  requiresAttention?: boolean;
  limit?: number;
}

export interface ResolveCustomerFeedbackResult {
  feedback: IOrderFeedbackDocument;
  idempotent: boolean;
}

const aiFeedbackClassificationSchema = z
  .object({
    type: z.enum(orderFeedbackTypes),
    sentiment: z.enum(orderFeedbackSentiments),
    rating: z.number().int().min(1).max(5).optional(),
    requiresOwnerAttention: z.boolean(),
    receiptStatus: z.enum(["received", "not_received", "unclear"]),
    summary: z.string().trim().min(1).max(240).optional()
  })
  .strict();

const normalizeText = (value: string): string =>
  value.trim().replace(/\s+/g, " ");

const getOrderReference = (order: Pick<IOrderDocument, "_id" | "orderNumber">): string =>
  order.orderNumber ?? String(order._id);

const extractOrderNumber = (message: string): string | undefined =>
  message.match(/\bORD-[A-Za-z0-9-]+\b/i)?.[0];

const extractRating = (message: string): number | undefined => {
  const match = message.match(/\b([1-5])\s*(?:\/\s*5|stars?)\b/i);

  return match ? Number(match[1]) : undefined;
};

const buildSummary = (message: string): string => {
  const normalized = normalizeText(message);

  return normalized.length <= 180
    ? normalized
    : `${normalized.slice(0, 177)}...`;
};

export const classifyDeterministicOrderFeedback = (
  rawMessage: string
): FeedbackClassification | null => {
  const message = normalizeText(rawMessage);
  const normalized = message.toLowerCase();
  const rating = extractRating(message);
  const nonDelivery =
    /\b(?:have|has|had)?\s*not\s+(?:received|got|gotten)\b/.test(normalized) ||
    /\b(?:haven't|hasn't|didn't)\s+(?:received?|get|got|gotten|arrived?)\b/.test(normalized) ||
    /\b(?:order|food|delivery)\s+(?:has\s+not|hasn't|never)\s+arrived\b/.test(normalized) ||
    /\bnot\s+(?:yet\s+)?arrived\b/.test(normalized) ||
    /\bstill\s+waiting\b/.test(normalized);

  if (nonDelivery) {
    return {
      type: "delivery_not_received",
      sentiment: "negative",
      rating,
      requiresOwnerAttention: true,
      receiptStatus: "not_received",
      summary: buildSummary(message)
    };
  }

  if (
    /^(?:i\s+)?(?:want|need|would\s+like)\s+to\s+complain[.!]?$/i.test(
      message
    ) ||
    /^complaint[.!]?$/i.test(message)
  ) {
    return null;
  }

  const hasSystemContext =
    /\b(orderbridge|ordering\s+system|agent|bot|app|website|checkout|card\s+payments?|payment\s+option)\b/.test(
      normalized
    );
  const hasRestaurantContext =
    /\b(food|meal|rice|soup|stew|chicken|fish|drink|portion|taste|delivery|driver|rider|packaging|restaurant|order)\b/.test(
      normalized
    );
  const hasPositive =
    /\b(nice|delicious|tasty|good|great|amazing|excellent|perfect|loved|satisfied|enjoyed)\b/.test(
      normalized
    );
  const hasNegative =
    /\b(late|slow|cold|spicy|salty|burnt|bad|wrong|missing|poor|rude|stale|small|disappointed|terrible|awful)\b/.test(
      normalized
    );
  const hasSuggestion =
    /\b(should|could|suggest|recommend|please\s+add|add\s+more|offer|introduce|would\s+be\s+better)\b/.test(
      normalized
    );

  if (hasSystemContext && hasRestaurantContext && (hasPositive || hasNegative)) {
    return {
      type: "mixed",
      sentiment: hasPositive && hasNegative ? "mixed" : hasNegative ? "negative" : "positive",
      rating,
      requiresOwnerAttention: hasNegative,
      receiptStatus: "received",
      summary: buildSummary(message)
    };
  }

  if (hasSystemContext) {
    return {
      type: "system_feedback",
      sentiment: hasPositive && hasNegative ? "mixed" : hasNegative ? "negative" : hasPositive ? "positive" : "neutral",
      rating,
      requiresOwnerAttention: false,
      receiptStatus: "unclear",
      summary: buildSummary(message)
    };
  }

  if (hasSuggestion) {
    return {
      type: "suggestion",
      sentiment: hasNegative ? "negative" : "neutral",
      rating,
      requiresOwnerAttention: false,
      receiptStatus: hasRestaurantContext && (hasPositive || hasNegative) ? "received" : "unclear",
      summary: buildSummary(message)
    };
  }

  if (hasRestaurantContext && hasPositive && hasNegative) {
    return {
      type: "mixed",
      sentiment: "mixed",
      rating,
      requiresOwnerAttention: true,
      receiptStatus: "received",
      summary: buildSummary(message)
    };
  }

  if (hasRestaurantContext && hasNegative) {
    return {
      type: "complaint",
      sentiment: "negative",
      rating,
      requiresOwnerAttention: true,
      receiptStatus: "received",
      summary: buildSummary(message)
    };
  }

  if (hasRestaurantContext && hasPositive) {
    return {
      type: "review",
      sentiment: "positive",
      rating,
      requiresOwnerAttention: false,
      receiptStatus: "received",
      summary: buildSummary(message)
    };
  }

  if (rating) {
    return {
      type: rating >= 4 ? "review" : rating <= 2 ? "complaint" : "review",
      sentiment: rating >= 4 ? "positive" : rating <= 2 ? "negative" : "neutral",
      rating,
      requiresOwnerAttention: rating <= 2,
      receiptStatus: "unclear",
      summary: buildSummary(message)
    };
  }

  return null;
};

export const isExplicitNaturalOrderFeedback = (rawMessage: string): boolean => {
  const message = normalizeText(rawMessage);

  if (!message || /^[123][.!]?$/.test(message)) {
    return false;
  }

  if (
    /^(?:i\s+)?(?:want|need|would\s+like)\s+to\s+complain[.!]?$/i.test(
      message
    ) ||
    /^complaint[.!]?$/i.test(message)
  ) {
    return true;
  }

  const classification = classifyDeterministicOrderFeedback(message);

  if (!classification || classification.receiptStatus === "unclear") {
    return false;
  }

  return /\b(?:received|arrived|got\s+it|picked\s+it\s+up|picked\s+up|previous\s+order|last\s+order|still\s+waiting|enjoyed|complaint|food\s+was|meal\s+was|order\s+was)\b|\b(?:haven't|hasn't|didn't)\s+(?:received?|get|got|gotten|arrived?)\b/i.test(
    message
  );
};

const parseAiJson = (text: string): unknown => {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  return JSON.parse(withoutFence);
};

export const classifyOpenEndedOrderFeedback = async (
  message: string
): Promise<FeedbackClassification | null> => {
  if (getAiProviderName() !== "openrouter") {
    return null;
  }

  const config = getOpenRouterConfig();

  if (!config.apiKey || !config.model) {
    return null;
  }

  try {
    const provider = createAiProvider();
    const response = await provider.complete({
      messages: [
        {
          role: "system",
          content: [
            "Classify one post-order customer message.",
            "Return only a JSON object with keys: type, sentiment, optional rating, requiresOwnerAttention, receiptStatus, optional summary.",
            `type must be one of: ${orderFeedbackTypes.join(", ")}.`,
            `sentiment must be one of: ${orderFeedbackSentiments.join(", ")}.`,
            "receiptStatus must be received, not_received, or unclear.",
            "Do not infer receipt from vague system feedback or a bare wish to complain.",
            "Do not include IDs, phone numbers, recipients, database filters, or restaurant context."
          ].join(" ")
        },
        {
          role: "user",
          content: message
        }
      ],
      tools: [],
      toolChoice: "none"
    });

    if (!response.text) {
      return null;
    }

    const parsed = aiFeedbackClassificationSchema.parse(
      parseAiJson(response.text)
    );

    if (
      parsed.type === "delivery_not_received" ||
      parsed.receiptStatus === "not_received"
    ) {
      return {
        ...parsed,
        type: "delivery_not_received",
        sentiment: "negative",
        requiresOwnerAttention: true,
        receiptStatus: "not_received"
      };
    }

    if (parsed.type === "complaint") {
      return {
        ...parsed,
        requiresOwnerAttention: true
      };
    }

    return parsed;
  } catch (error) {
    console.error("Open-ended order feedback classification failed", {
      error:
        error instanceof Error
          ? error.message
          : "Unknown feedback classification error"
    });
    return null;
  }
};

export const buildOwnerFeedbackNotification = (
  feedback: Pick<
    IOrderFeedbackDocument,
    | "orderNumber"
    | "customerName"
    | "customerPhone"
    | "type"
    | "message"
    | "sentiment"
    | "requiresOwnerAttention"
  >
): string => {
  const customer = feedback.customerName || feedback.customerPhone;
  if (feedback.type === "delivery_not_received") {
    return [
      "🚨 ORDER NOT RECEIVED",
      "",
      `${customer} says order ${feedback.orderNumber} has not been received.`,
      "",
      "Please check this order."
    ].join("\n");
  }

  if (feedback.type === "review") {
    return [
      "⭐ CUSTOMER REVIEW",
      "",
      customer,
      `Order ${feedback.orderNumber}`,
      "",
      `“${feedback.message}”`
    ].join("\n");
  }

  if (feedback.type === "suggestion") {
    return [
      "💡 CUSTOMER SUGGESTION",
      "",
      customer,
      `Order ${feedback.orderNumber}`,
      "",
      `“${feedback.message}”`
    ].join("\n");
  }

  return [
    "⚠️ CUSTOMER COMPLAINT",
    "",
    customer,
    `Order ${feedback.orderNumber}`,
    "",
    `“${feedback.message}”`
  ].join("\n");
};

export const notifyOwnerOfOrderFeedback = async (
  feedback: IOrderFeedbackDocument
): Promise<void> => {
  const restaurantId = String(feedback.restaurantId);
  const restaurant = await Restaurant.findOne({ _id: restaurantId }).select(
    "+wasenderApiToken"
  );

  if (
    !restaurant ||
    !restaurant.ownerPhone?.trim() ||
    !restaurant.wasenderSessionId?.trim() ||
    !restaurant.wasenderApiToken?.trim()
  ) {
    const failedAt = new Date();
    await OrderFeedback.updateOne(
      { _id: feedback._id, restaurantId },
      {
        $set: {
          ownerNotificationFailedAt: failedAt,
          ownerNotificationFailureReason:
            "Restaurant owner Wasender credentials are unavailable"
        }
      }
    );
    return;
  }

  try {
    await enqueueWasenderMessage({
      restaurantId,
      sessionId: restaurant.wasenderSessionId,
      to: normalizeGhanaPhone(restaurant.ownerPhone),
      type: "text",
      text: buildOwnerFeedbackNotification(feedback),
      apiKey: restaurant.wasenderApiToken,
      idempotencyKey: `order-feedback-owner-notification:${String(feedback._id)}:v1`,
      metadata: {
        kind: "order_feedback_owner_notification",
        restaurantId,
        orderId: String(feedback.orderId),
        orderNumber: feedback.orderNumber,
        feedbackId: String(feedback._id),
        purpose: "transactional",
        recipientType: "owner"
      }
    });
  } catch (error) {
    await OrderFeedback.updateOne(
      { _id: feedback._id, restaurantId },
      {
        $set: {
          ownerNotificationFailedAt: new Date(),
          ownerNotificationFailureReason:
            error instanceof Error
              ? error.message
              : "Owner feedback notification could not be queued"
        }
      }
    );
  }
};

interface CreateFeedbackInput {
  restaurantId: string;
  order: IOrderDocument;
  message: string;
  classification: FeedbackClassification;
  inboundEventId?: string;
}

export const createOrderFeedback = async (
  input: CreateFeedbackInput
): Promise<IOrderFeedbackDocument> => {
  const normalizedMessage = normalizeText(input.message);
  let feedback: IOrderFeedbackDocument;
  let created = false;

  try {
    feedback = await OrderFeedback.create({
      restaurantId: input.restaurantId,
      orderId: input.order._id,
      orderNumber: getOrderReference(input.order),
      customerPhone: normalizeGhanaPhone(input.order.customerPhone),
      customerName: input.order.customerName,
      type: input.classification.type,
      message: normalizedMessage,
      summary: input.classification.summary,
      sentiment: input.classification.sentiment,
      rating: input.classification.rating,
      requiresOwnerAttention: input.classification.requiresOwnerAttention,
      inboundEventId: input.inboundEventId
    });
    created = true;
  } catch (error) {
    if (
      input.inboundEventId &&
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: number }).code === 11000
    ) {
      const existing = await OrderFeedback.findOne({
        restaurantId: input.restaurantId,
        inboundEventId: input.inboundEventId
      });

      if (existing) {
        feedback = existing;
      } else {
        throw error;
      }
    } else {
      throw error;
    }
  }

  if (
    meaningfulOwnerFeedbackTypes.has(feedback.type) &&
    (created || !feedback.ownerNotifiedAt)
  ) {
    await notifyOwnerOfOrderFeedback(feedback);
  }

  return feedback;
};

export const findActiveFeedbackOrders = async (
  restaurantId: string,
  customerPhone: string
): Promise<IOrderDocument[]> => {
  return Order.find({
    restaurantId,
    customerPhone: { $in: getEquivalentCustomerPhones(customerPhone) },
    feedbackRequestSentAt: { $exists: true },
    $or: [
      {
        status: { $in: feedbackCompletionEligibleStatuses },
        feedbackFollowUpStatus: { $in: ["requested", "answered", "issue_reported"] }
      },
      {
        status: "completed",
        feedbackAwaitingComplaint: true
      },
      {
        status: { $in: [...feedbackCompletionEligibleStatuses, "completed"] },
        feedbackReceiptClarificationPending: true
      }
    ]
  }).sort({ feedbackRequestSentAt: -1, createdAt: -1 });
};

const meaningfulOwnerFeedbackTypes = new Set<OrderFeedbackType>([
  "review",
  "complaint",
  "suggestion",
  "delivery_not_received",
  "mixed"
]);

export interface ActiveOrderCheckInView {
  orderNumber: string;
  orderType: IOrderDocument["orderType"];
  status: IOrderDocument["status"];
  checkInStatus: IOrderDocument["feedbackFollowUpStatus"];
  awaitingComplaint: boolean;
  receiptClarificationPending: boolean;
}

export const loadActiveOrderCheckInState = async (
  restaurantId: string,
  customerPhone: string
): Promise<ActiveOrderCheckInView[]> => {
  const orders = await findActiveFeedbackOrders(restaurantId, customerPhone);

  return orders.map((order) => ({
    orderNumber: getOrderReference(order),
    orderType: order.orderType,
    status: order.status,
    checkInStatus: order.feedbackFollowUpStatus,
    awaitingComplaint: Boolean(order.feedbackAwaitingComplaint),
    receiptClarificationPending: Boolean(
      order.feedbackReceiptClarificationPending
    )
  }));
};

export const resolveQuotedOrderFeedbackOrderId = async (
  restaurantId: string,
  customerPhone: string,
  quotedMessageId?: string
): Promise<string | null> => {
  const providerMessageId = quotedMessageId?.trim();

  if (!Types.ObjectId.isValid(restaurantId) || !providerMessageId) {
    return null;
  }

  const normalizedPhone = normalizeGhanaPhone(customerPhone);
  const queuedMessage = await OutboundMessage.findOne({
    restaurantId,
    to: normalizedPhone,
    status: "sent",
    providerMessageId,
    "metadata.kind": {
      $in: ["order_feedback_request", "order_feedback_reminder"]
    },
    "metadata.customerPhone": normalizedPhone
  })
    .sort({ sentAt: -1 })
    .select("metadata");
  const orderId =
    queuedMessage?.metadata &&
    typeof queuedMessage.metadata.orderId === "string"
      ? queuedMessage.metadata.orderId
      : "";

  return Types.ObjectId.isValid(orderId) ? orderId : null;
};

const selectFeedbackOrder = (
  orders: IOrderDocument[],
  message: string,
  trustedOrderId?: string
):
  | { order: IOrderDocument }
  | { ambiguity: string[] }
  | { unmatchedReference: string } => {
  if (trustedOrderId) {
    const trustedOrder = orders.find(
      (order) => String(order._id) === trustedOrderId
    );

    if (trustedOrder) {
      return { order: trustedOrder };
    }

    return { unmatchedReference: trustedOrderId };
  }

  const quotedOrderNumber = extractOrderNumber(message);

  if (quotedOrderNumber) {
    const matched = orders.find(
      (order) =>
        order.orderNumber?.toLowerCase() === quotedOrderNumber.toLowerCase()
    );

    if (matched) {
      return { order: matched };
    }

    return { unmatchedReference: quotedOrderNumber };
  }

  if (orders.length === 1) {
    return { order: orders[0] };
  }

  return {
    ambiguity: orders.map(getOrderReference)
  };
};

const parseNumberedResponse = (
  message: string
): { option: 1 | 2 | 3; comment: string } | null => {
  const withoutOrderReference = normalizeText(message)
    .replace(/\bORD-[A-Za-z0-9-]+\b/gi, " ")
    .replace(/^\s*[-:]\s*/, "")
    .trim();
  const match = withoutOrderReference.match(
    /^([123])(?:[.)-]\s*|\s+|$)(.*)$/s
  );

  if (!match) {
    return null;
  }

  return {
    option: Number(match[1]) as 1 | 2 | 3,
    comment: normalizeText(match[2] ?? "")
  };
};

const isActualPositiveComment = (comment: string): boolean => {
  if (!comment) {
    return false;
  }

  return !/^(?:received|satisfied|received\s+and\s+satisfied|yes|ok|okay)[.!]?$/i.test(
    comment
  );
};

const isActualComplaint = (comment: string): boolean =>
  Boolean(comment) &&
  !/^(?:complaint|i\s+have\s+a\s+complaint|received)[.!]?$/i.test(comment);

const markFeedbackAnswered = async (
  restaurantId: string,
  orderId: string,
  now: Date,
  updates: Record<string, unknown> = {}
): Promise<void> => {
  await Order.updateOne(
    { _id: orderId, restaurantId },
    {
      $set: {
        feedbackReceivedAt: now,
        feedbackFollowUpStatus: "answered",
        ...updates
      }
    }
  );
};


const handleDeliveryNotReceived = async (
  input: HandleOrderFeedbackResponseInput,
  order: IOrderDocument,
  message: string
): Promise<HandleOrderFeedbackResponseResult> => {
  const now = new Date();
  const orderId = String(order._id);
  await Order.updateOne(
    { _id: orderId, restaurantId: input.restaurantId },
    {
      $set: {
        feedbackReceivedAt: now,
        feedbackFollowUpStatus: "issue_reported",
        feedbackAwaitingComplaint: false,
        feedbackReceiptClarificationPending: false
      }
    }
  );
  await cancelQueuedOrderFeedbackMessages(
    input.restaurantId,
    orderId,
    "Customer reported that the order was not received"
  );
  const feedback = await createOrderFeedback({
    restaurantId: input.restaurantId,
    order,
    message,
    inboundEventId: input.inboundEventId,
    classification: {
      type: "delivery_not_received",
      sentiment: "negative",
      requiresOwnerAttention: true,
      receiptStatus: "not_received",
      summary: buildSummary(message)
    }
  });

  return {
    handled: true,
    success: true,
    message: `${order.customerName ? `${order.customerName}, ` : ""}${getOrderReference(order)} has been flagged as not received. The restaurant has been alerted and will follow up.`,
    order,
    feedback
  };
};

const handleNumberedResponse = async (
  input: HandleOrderFeedbackResponseInput,
  order: IOrderDocument,
  numbered: { option: 1 | 2 | 3; comment: string },
  dependencies: OrderFeedbackResponseDependencies
): Promise<HandleOrderFeedbackResponseResult> => {
  const now = new Date();
  const orderId = String(order._id);

  if (numbered.option === 3) {
    return handleDeliveryNotReceived(input, order, input.message);
  }

  const completionSource =
    numbered.option === 1 ? "customer_confirmed" : "customer_feedback";
  const completed = await completeOrderThroughFeedback({
    restaurantId: input.restaurantId,
    orderId,
    completionSource,
    completionConfirmedByCustomer: true,
    completedAt: now
  });

  if (numbered.option === 1) {
    let feedback: IOrderFeedbackDocument | undefined;

    if (isActualPositiveComment(numbered.comment)) {
      feedback = await createOrderFeedback({
        restaurantId: input.restaurantId,
        order: completed.order,
        message: numbered.comment,
        inboundEventId: input.inboundEventId,
        classification: {
          type: "review",
          sentiment: "positive",
          requiresOwnerAttention: false,
          receiptStatus: "received",
          summary: buildSummary(numbered.comment)
        }
      });
    }

    await markFeedbackAnswered(input.restaurantId, orderId, now, {
      feedbackAwaitingComplaint: false,
      feedbackReceiptClarificationPending: false
    });

    return {
      handled: true,
      success: true,
      message: feedback
        ? "Thanks for the feedback. We have shared it with the restaurant."
        : "Thanks for confirming. Your order is now marked complete.",
      order: completed.order,
      feedback
    };
  }

  if (!isActualComplaint(numbered.comment)) {
    await markFeedbackAnswered(input.restaurantId, orderId, now, {
      feedbackAwaitingComplaint: true,
      feedbackReceiptClarificationPending: false
    });

    return {
      handled: true,
      success: true,
      message: "Thanks for confirming you received it. What went wrong? Please send one short message and I’ll alert the restaurant.",
      order: completed.order
    };
  }

  const feedback = await createOrderFeedback({
    restaurantId: input.restaurantId,
    order: completed.order,
    message: numbered.comment,
    inboundEventId: input.inboundEventId,
    classification: {
      type: "complaint",
      sentiment: "negative",
      requiresOwnerAttention: true,
      receiptStatus: "received",
      summary: buildSummary(numbered.comment)
    }
  });
  await markFeedbackAnswered(input.restaurantId, orderId, now, {
    feedbackAwaitingComplaint: false,
    feedbackReceiptClarificationPending: false
  });

  return {
    handled: true,
    success: true,
    message: "Thanks for telling us. The restaurant has been alerted about your complaint.",
    order: completed.order,
    feedback
  };
};

const handlePendingComplaint = async (
  input: HandleOrderFeedbackResponseInput,
  order: IOrderDocument
): Promise<HandleOrderFeedbackResponseResult> => {
  const message = normalizeText(input.message);

  if (!isActualComplaint(message)) {
    return {
      handled: true,
      success: true,
      message: "Please tell me briefly what went wrong with the order.",
      order
    };
  }

  const feedback = await createOrderFeedback({
    restaurantId: input.restaurantId,
    order,
    message,
    inboundEventId: input.inboundEventId,
    classification: {
      type: "complaint",
      sentiment: "negative",
      requiresOwnerAttention: true,
      receiptStatus: "received",
      summary: buildSummary(message)
    }
  });
  await markFeedbackAnswered(
    input.restaurantId,
    String(order._id),
    new Date(),
    { feedbackAwaitingComplaint: false }
  );

  return {
    handled: true,
    success: true,
    message: "Thanks for explaining. The restaurant has been alerted and will follow up.",
    order,
    feedback
  };
};

const handleReceiptClarification = async (
  input: HandleOrderFeedbackResponseInput,
  order: IOrderDocument
): Promise<HandleOrderFeedbackResponseResult> => {
  const message = normalizeText(input.message).toLowerCase();

  if (/^(?:yes|yes\s+i\s+did|received|i\s+received\s+it|it\s+arrived)[.!]?$/.test(message)) {
    const completed = await completeOrderThroughFeedback({
      restaurantId: input.restaurantId,
      orderId: String(order._id),
      completionSource: "customer_feedback",
      completionConfirmedByCustomer: true
    });
    await markFeedbackAnswered(
      input.restaurantId,
      String(order._id),
      new Date(),
      { feedbackReceiptClarificationPending: false }
    );

    return {
      handled: true,
      success: true,
      message: "Thanks for confirming. Your order is now marked complete.",
      order: completed.order
    };
  }

  if (/^(?:no|not\s+yet|i\s+did\s+not|it\s+hasn't\s+arrived)[.!]?$/.test(message)) {
    return handleDeliveryNotReceived(input, order, input.message);
  }

  return {
    handled: true,
    success: true,
    message: `Just to confirm ${getOrderReference(order)}: did you receive the order, or are you still waiting for it?`,
    order
  };
};

export const handleOrderFeedbackCustomerResponse = async (
  input: HandleOrderFeedbackResponseInput,
  dependencies: OrderFeedbackResponseDependencies = {}
): Promise<HandleOrderFeedbackResponseResult> => {
  const message = normalizeText(input.message);

  if (!message) {
    return { handled: false, success: false };
  }

  const orders = await findActiveFeedbackOrders(
    input.restaurantId,
    input.customerPhone
  );

  if (orders.length === 0) {
    return { handled: false, success: false };
  }

  const selected = selectFeedbackOrder(
    orders,
    message,
    input.trustedOrderId
  );

  if ("unmatchedReference" in selected) {
    return {
      handled: true,
      success: false,
      message: `I could not match ${selected.unmatchedReference} to an active feedback request. Please reply with one of: ${orders.map(getOrderReference).join(", ")}.`,
      ambiguousOrderNumbers: orders.map(getOrderReference)
    };
  }

  if ("ambiguity" in selected) {
    return {
      handled: true,
      success: false,
      message: `Which order are you replying about? Please include the order number: ${selected.ambiguity.join(", ")}.`,
      ambiguousOrderNumbers: selected.ambiguity
    };
  }

  const order = selected.order;
  const numbered = parseNumberedResponse(message);

  if (numbered) {
    return handleNumberedResponse(input, order, numbered, dependencies);
  }

  if (order.feedbackAwaitingComplaint) {
    return handlePendingComplaint(input, order);
  }

  if (order.feedbackReceiptClarificationPending) {
    return handleReceiptClarification(input, order);
  }

  if (
    /^(?:i\s+)?(?:want|need|would\s+like)\s+to\s+complain[.!]?$/i.test(
      message
    ) ||
    /^complaint[.!]?$/i.test(message)
  ) {
    await markFeedbackAnswered(
      input.restaurantId,
      String(order._id),
      new Date(),
      { feedbackReceiptClarificationPending: true }
    );
    await cancelQueuedOrderFeedbackMessages(
      input.restaurantId,
      String(order._id),
      "Customer requested a complaint receipt clarification"
    );

    return {
      handled: true,
      success: true,
      message: `I’m sorry something went wrong. Did you receive ${getOrderReference(order)}? Tell me whether it arrived, then add the complaint.`,
      order
    };
  }

  const classification =
    classifyDeterministicOrderFeedback(message) ??
    (await classifyOpenEndedOrderFeedback(message));

  if (!classification) {
    return {
      handled: true,
      success: true,
      message: `Thanks. To make sure I handle ${getOrderReference(order)} correctly, did you receive the order, or are you still waiting for it?`,
      order
    };
  }

  if (classification.receiptStatus === "not_received") {
    return handleDeliveryNotReceived(input, order, message);
  }

  const feedback = await createOrderFeedback({
    restaurantId: input.restaurantId,
    order,
    message,
    inboundEventId: input.inboundEventId,
    classification
  });
  const now = new Date();

  if (classification.receiptStatus === "received") {
    const completed = await completeOrderThroughFeedback({
      restaurantId: input.restaurantId,
      orderId: String(order._id),
      completionSource: "customer_feedback",
      completionConfirmedByCustomer: true,
      completedAt: now
    });
    await markFeedbackAnswered(
      input.restaurantId,
      String(order._id),
      now,
      {
        feedbackAwaitingComplaint: false,
        feedbackReceiptClarificationPending: false
      }
    );

    return {
      handled: true,
      success: true,
      message: classification.requiresOwnerAttention
        ? "Thanks for the feedback. The restaurant has been alerted and will follow up if needed."
        : "Thanks for the feedback. We have shared it with the restaurant.",
      order: completed.order,
      feedback
    };
  }

  await markFeedbackAnswered(
    input.restaurantId,
    String(order._id),
    now,
    { feedbackReceiptClarificationPending: true }
  );
  await cancelQueuedOrderFeedbackMessages(
    input.restaurantId,
    String(order._id),
    "Customer feedback was received and receipt needs clarification"
  );

  return {
    handled: true,
    success: true,
    message: `Thanks for the feedback. One quick check for ${getOrderReference(order)}: did you receive the order, or are you still waiting for it?`,
    order,
    feedback
  };
};

export const respondToOrderCheckIn = async (
  input: RespondToOrderCheckInInput
): Promise<HandleOrderFeedbackResponseResult> => {
  const option =
    input.outcome === "received_satisfied"
      ? "1"
      : input.outcome === "received_complaint"
        ? "2"
        : "3";
  const message = [input.orderReference, option, input.feedbackText]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" ");

  return handleOrderFeedbackCustomerResponse({
    restaurantId: input.restaurantId,
    customerPhone: input.customerPhone,
    customerName: input.customerName,
    message,
    inboundEventId: input.inboundEventId
  });
};

export const listCustomerFeedback = async (
  restaurantId: string,
  input: ListCustomerFeedbackInput = {}
): Promise<IOrderFeedbackDocument[]> => {
  if (!Types.ObjectId.isValid(restaurantId)) {
    throw new BadRequestError("Invalid restaurantId");
  }

  const limit = Math.max(1, Math.min(input.limit ?? 10, 20));

  return OrderFeedback.find({
    restaurantId,
    ...(input.type ? { type: input.type } : {}),
    ...(input.requiresAttention === undefined
      ? {}
      : { requiresOwnerAttention: input.requiresAttention })
  })
    .sort({ createdAt: -1 })
    .limit(limit);
};

export const resolveCustomerFeedback = async (
  restaurantId: string,
  feedbackId: string,
  resolvedByPhone: string
): Promise<ResolveCustomerFeedbackResult> => {
  if (!Types.ObjectId.isValid(restaurantId)) {
    throw new BadRequestError("Invalid restaurantId");
  }

  if (!Types.ObjectId.isValid(feedbackId)) {
    throw new BadRequestError("Invalid feedbackId");
  }

  const feedback = await OrderFeedback.findOne({
    _id: feedbackId,
    restaurantId
  });

  if (!feedback) {
    throw new NotFoundError("Customer feedback not found");
  }

  if (feedback.resolvedAt) {
    return { feedback, idempotent: true };
  }

  feedback.resolvedAt = new Date();
  feedback.resolvedByPhone = normalizeGhanaPhone(resolvedByPhone);
  await feedback.save();

  return { feedback, idempotent: false };
};
