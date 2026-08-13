import { Types } from "mongoose";
import { AgentConversationMessage } from "../models/agentConversation.model";
import {
  CustomerProfile,
  type MarketingConsentPromptSource
} from "../models/customerProfile.model";
import type { IOrderDocument } from "../models/order.model";
import { OutboundMessage } from "../models/outboundMessage.model";
import { Restaurant } from "../models/Restaurant";
import { BadRequestError } from "../utils/httpErrors";
import { normalizeGhanaPhone } from "../utils/phone.util";
import {
  enqueueWasenderMessage,
  type EnqueueWasenderMessageInput
} from "./wasenderQueue.service";

export type MarketingConsentResponse = "opt_in" | "opt_out";

export interface ParsedMarketingConsentResponse {
  command: MarketingConsentResponse;
  explicitlyMentionsMarketing: boolean;
}

export interface PendingMarketingConsentContext {
  pending: boolean;
  quotedRequest: boolean;
  genericResponseWindowOpen: boolean;
  promptedAt?: Date;
  promptOrderId?: string;
}

export interface QueueMarketingConsentRequestDependencies {
  findProfile?: (
    restaurantId: string,
    customerPhone: string
  ) => Promise<{
    marketingConsent?: boolean | null;
    isOptedOut?: boolean;
    marketingConsentPromptedAt?: Date;
    orderCount?: number;
  } | null>;
  findRestaurant?: (restaurantId: string) => Promise<{
    name: string;
    status: string;
    wasenderSessionId?: string;
    wasenderApiToken?: string;
  } | null>;
  enqueueMessage?: (
    input: EnqueueWasenderMessageInput
  ) => Promise<{
    _id?: unknown;
    status?: "pending" | "sending" | "sent" | "failed" | "cancelled";
  }>;
  markPrompted?: (
    filter: Record<string, unknown>,
    update: Record<string, unknown>
  ) => Promise<{ modifiedCount?: number }>;
}

export interface QueueMarketingConsentRequestResult {
  queued: boolean;
  reason?: string;
  idempotencyKey?: string;
}

export interface QueueMarketingConsentRequestInput {
  restaurantId: string;
  customerPhone: string;
  source: MarketingConsentPromptSource;
  orderId?: string;
  requestedByPhone?: string;
}

const normalizeConsentResponse = (message: string): string =>
  message
    .trim()
    .replace(/[’‘]/g, "'")
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();

const genericOptInResponses = new Set([
  "yes",
  "yes please",
  "sure",
  "ok",
  "okay",
  "i'd like that"
]);
const explicitOptInResponses = new Set([
  "send me offers",
  "send me promotions",
  "subscribe me"
]);
genericOptInResponses.add("keep me updated");
const genericOptOutResponses = new Set([
  "no",
  "no thanks",
  "not interested"
]);
const explicitOptOutResponses = new Set([
  "no promotions",
  "don't send me offers",
  "do not send me offers"
]);

export const parseMarketingConsentResponse = (
  message: string
): ParsedMarketingConsentResponse | null => {
  const normalized = normalizeConsentResponse(message);

  if (explicitOptInResponses.has(normalized)) {
    return { command: "opt_in", explicitlyMentionsMarketing: true };
  }

  if (genericOptInResponses.has(normalized)) {
    return { command: "opt_in", explicitlyMentionsMarketing: false };
  }

  if (explicitOptOutResponses.has(normalized)) {
    return { command: "opt_out", explicitlyMentionsMarketing: true };
  }

  if (genericOptOutResponses.has(normalized)) {
    return { command: "opt_out", explicitlyMentionsMarketing: false };
  }

  return null;
};

const ensureScopedIdentity = (
  restaurantId: string,
  customerPhone: string
): string => {
  if (!Types.ObjectId.isValid(restaurantId)) {
    throw new BadRequestError("Invalid restaurantId");
  }

  const normalizedPhone = normalizeGhanaPhone(customerPhone);

  if (!/^\+[1-9]\d{7,14}$/.test(normalizedPhone)) {
    throw new BadRequestError("Invalid customerPhone");
  }

  return normalizedPhone;
};

export const getMarketingConsentRequestIdempotencyKey = (
  restaurantId: string,
  customerPhone: string
): string =>
  `marketing-consent-request:${restaurantId}:${normalizeGhanaPhone(customerPhone)}`;

export const buildMarketingConsentRequestMessage = (
  restaurantName: string
): string =>
  `Would you like ${restaurantName.trim()} to occasionally send you offers, discounts and new menu updates here on WhatsApp?\n\nReply YES to receive them or NO if you don't want them.\n\nYou can reply STOP anytime later.`;

export const isOrderEligibleForMarketingConsentPrompt = (
  order: Pick<
    IOrderDocument,
    "status" | "completionSource" | "completionConfirmedByCustomer"
  >
): boolean =>
  order.status === "completed" &&
  order.completionConfirmedByCustomer === true &&
  order.completionSource !== "automatic_timeout";

export const queueMarketingConsentRequest = async (
  input: QueueMarketingConsentRequestInput,
  dependencies: QueueMarketingConsentRequestDependencies = {},
  now = new Date()
): Promise<QueueMarketingConsentRequestResult> => {
  const restaurantId = input.restaurantId;
  const customerPhone = ensureScopedIdentity(
    restaurantId,
    input.customerPhone
  );
  const requestedByPhone = input.requestedByPhone
    ? ensureScopedIdentity(restaurantId, input.requestedByPhone)
    : undefined;

  if (input.orderId && !Types.ObjectId.isValid(input.orderId)) {
    throw new BadRequestError("Invalid orderId");
  }

  const findProfile =
    dependencies.findProfile ??
    (async (scopedRestaurantId, scopedCustomerPhone) =>
      CustomerProfile.findOne({
        restaurantId: scopedRestaurantId,
        customerPhone: scopedCustomerPhone
      }).select(
        "marketingConsent isOptedOut marketingConsentPromptedAt orderCount"
      ));
  const profile = await findProfile(restaurantId, customerPhone);

  if (!profile) {
    return { queued: false, reason: "profile_missing" };
  }

  if (profile.marketingConsent === true) {
    return { queued: false, reason: "already_opted_in" };
  }

  if (profile.isOptedOut === true || profile.marketingConsent === false) {
    return { queued: false, reason: "already_opted_out" };
  }

  if (profile.marketingConsentPromptedAt) {
    return { queued: false, reason: "already_prompted" };
  }

  const findRestaurant =
    dependencies.findRestaurant ??
    (async (scopedRestaurantId) =>
      Restaurant.findOne({
        _id: scopedRestaurantId,
        status: { $in: ["trial", "active"] }
      }).select("name status wasenderSessionId +wasenderApiToken"));
  const restaurant = await findRestaurant(restaurantId);

  if (
    !restaurant ||
    !restaurant.wasenderSessionId?.trim() ||
    !restaurant.wasenderApiToken?.trim()
  ) {
    return { queued: false, reason: "restaurant_delivery_unavailable" };
  }

  const idempotencyKey = getMarketingConsentRequestIdempotencyKey(
    restaurantId,
    customerPhone
  );
  const enqueueMessage =
    dependencies.enqueueMessage ?? enqueueWasenderMessage;
  const queuedMessage = await enqueueMessage({
    restaurantId,
    sessionId: restaurant.wasenderSessionId,
    to: customerPhone,
    type: "text",
    text: buildMarketingConsentRequestMessage(restaurant.name),
    apiKey: restaurant.wasenderApiToken,
    idempotencyKey,
    metadata: {
      kind: "marketing_consent_request",
      purpose: "transactional_preference",
      restaurantId,
      customerPhone,
      source: input.source,
      ...(input.orderId ? { orderId: input.orderId } : {}),
      ...(requestedByPhone ? { requestedByPhone } : {})
    }
  });

  if (
    queuedMessage.status === "failed" ||
    queuedMessage.status === "cancelled"
  ) {
    return {
      queued: false,
      reason: `consent_request_${queuedMessage.status}`,
      idempotencyKey
    };
  }

  const markPrompted =
    dependencies.markPrompted ??
    ((filter, update) => CustomerProfile.updateOne(filter, update));
  await markPrompted(
    {
      restaurantId,
      customerPhone,
      marketingConsent: null,
      isOptedOut: { $ne: true },
      marketingConsentPromptedAt: { $exists: false }
    },
    {
      $set: {
        marketingConsentPromptedAt: now,
        marketingConsentPromptSource: input.source,
        ...(input.orderId
          ? { marketingConsentPromptOrderId: new Types.ObjectId(input.orderId) }
          : {}),
        ...(requestedByPhone
          ? { marketingConsentPromptedByPhone: requestedByPhone }
          : {})
      }
    }
  );

  return { queued: true, idempotencyKey };
};

export const queueMarketingConsentRequestAfterSuccessfulOrder = async (
  order: Pick<
    IOrderDocument,
    | "_id"
    | "restaurantId"
    | "customerPhone"
    | "status"
    | "completionSource"
    | "completionConfirmedByCustomer"
  >,
  dependencies: QueueMarketingConsentRequestDependencies = {},
  now = new Date()
): Promise<QueueMarketingConsentRequestResult> => {
  if (!isOrderEligibleForMarketingConsentPrompt(order)) {
    return { queued: false, reason: "order_not_eligible" };
  }

  const restaurantId = String(order.restaurantId);
  const customerPhone = ensureScopedIdentity(restaurantId, order.customerPhone);
  const findProfile =
    dependencies.findProfile ??
    (async (scopedRestaurantId, scopedCustomerPhone) =>
      CustomerProfile.findOne({
        restaurantId: scopedRestaurantId,
        customerPhone: scopedCustomerPhone
      }).select(
        "marketingConsent isOptedOut marketingConsentPromptedAt orderCount"
      ));
  const profile = await findProfile(restaurantId, customerPhone);

  if (!profile || (profile.orderCount ?? 0) < 1) {
    return { queued: false, reason: "completed_profile_missing" };
  }

  return queueMarketingConsentRequest(
    {
      restaurantId,
      customerPhone,
      source: "post_order",
      orderId: String(order._id)
    },
    {
      ...dependencies,
      findProfile: async () => profile
    },
    now
  );
};

export const recordMarketingConsentPromptResponse = async (
  restaurantId: string,
  customerPhone: string,
  response: MarketingConsentResponse,
  now = new Date()
): Promise<boolean> => {
  const normalizedPhone = ensureScopedIdentity(restaurantId, customerPhone);
  const result = await CustomerProfile.updateOne(
    {
      restaurantId,
      customerPhone: normalizedPhone,
      marketingConsentPromptedAt: { $exists: true },
      marketingConsentPromptResponse: { $exists: false }
    },
    {
      $set: {
        marketingConsentPromptResponse: response,
        marketingConsentPromptRespondedAt: now
      }
    }
  );

  return (result.modifiedCount ?? 0) > 0;
};

export const getPendingMarketingConsentContext = async (
  restaurantId: string,
  customerPhone: string,
  quotedMessageId?: string
): Promise<PendingMarketingConsentContext> => {
  const normalizedPhone = ensureScopedIdentity(
    restaurantId,
    customerPhone
  );
  const profile = await CustomerProfile.findOne({
    restaurantId,
    customerPhone: normalizedPhone
  }).select(
    "marketingConsent isOptedOut marketingConsentPromptedAt marketingConsentPromptOrderId"
  );
  const pending = Boolean(
    profile &&
      profile.marketingConsent == null &&
      profile.isOptedOut !== true &&
      profile.marketingConsentPromptedAt
  );

  if (!pending) {
    return {
      pending: false,
      quotedRequest: false,
      genericResponseWindowOpen: false
    };
  }

  const providerMessageId = quotedMessageId?.trim();
  const requestScope = {
    restaurantId,
    to: normalizedPhone,
    status: "sent",
    "metadata.kind": "marketing_consent_request",
    "metadata.customerPhone": normalizedPhone
  } as const;
  const [quotedMessage, latestSentRequest] = await Promise.all([
    providerMessageId
      ? OutboundMessage.findOne({
          ...requestScope,
          providerMessageId
        }).select("_id sentAt")
      : Promise.resolve(null),
    OutboundMessage.findOne({
      ...requestScope,
      sentAt: { $exists: true }
    })
      .sort({ sentAt: -1 })
      .select("_id sentAt")
  ]);
  const quotedRequest = Boolean(quotedMessage);
  const interveningCustomerMessage = latestSentRequest?.sentAt
    ? await AgentConversationMessage.exists({
        restaurantId,
        senderPhone: normalizedPhone,
        senderRole: "customer",
        direction: "user",
        createdAt: { $gt: latestSentRequest.sentAt }
      })
    : null;

  return {
    pending: true,
    quotedRequest,
    genericResponseWindowOpen: Boolean(
      latestSentRequest?.sentAt && !interveningCustomerMessage
    ),
    promptedAt: profile?.marketingConsentPromptedAt,
    promptOrderId: profile?.marketingConsentPromptOrderId
      ? String(profile.marketingConsentPromptOrderId)
      : undefined
  };
};
