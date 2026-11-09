import { Types } from "mongoose";
import { Order } from "../models/order.model";
import { PendingAgentAction } from "../models/pendingAgentAction.model";
import { Restaurant } from "../models/Restaurant";
import { Business } from "../models/business.model";
import { CommerceReceipt } from "../models/commerceReceipt.model";
import { CommerceReviewInvitationJob } from "../models/commerceReviewInvitationJob.model";
import { CommercePaidOrderEvent } from "../models/commercePaidOrderEvent.model";
import { CustomerCampaign } from "../models/customerCampaign.model";
import { CustomerCampaignRecipient } from "../models/customerCampaignRecipient.model";
import { CustomerProfile } from "../models/customerProfile.model";
import { MenuItem } from "../models/MenuItem";
import { CustomerSession, type ICustomerSessionDocument } from "../models/customerSession.model";
import {
  buildDraftFollowUpContextKey,
  type CustomerDraftFollowUpState
} from "./orderDraft.service";
import {
  OutboundMessage,
  type IOutboundMessageDocument,
  type OutboundMessageType
} from "../models/outboundMessage.model";
import {
  extractWasenderProviderMessageId,
  sendDocumentMessage,
  sendImageMessage,
  sendTextMessage,
  type WasenderSendResult
} from "./wasender.service";
import {
  markRuntimeRunFailed,
  markRuntimeRunStarted,
  markRuntimeRunSucceeded,
  markRuntimeStarted
} from "./runtimeHealth.service";
import { resolveSenderIdentity } from "./senderIdentity.service";
import {
  campaignTypeAllowsNoConsent,
  updateCustomerCampaignAggregate,
  validateCustomerCampaignMedia
} from "./customerCampaign.service";
import {
  isValidWhatsappRecipient,
  isWhatsappPhoneAddress,
  normalizeGhanaPhone,
  normalizeWhatsappRecipient
} from "../utils/phone.util";
import {
  getCustomerIdentityFilter,
  normalizeCustomerKey,
  resolveCurrentWhatsappRecipientResult
} from "./customerIdentity.service";
import { redactUrls } from "../utils/error.util";
import {
  applyOrderFeedbackProviderResult,
  getQueuedOrderFeedbackStaleReason,
  scheduleOrderFeedbackFollowUp
} from "./orderFeedbackQueue.service";
import {
  commercePaidOrderCustomerNotificationKind,
  commercePaidOrderReceiptNotificationKind,
  commercePaidOrderStaffNotificationKind,
  commercePurchaseReviewInvitationKind,
  commerceWhatsappChatReplyKind,
  getCommerceNotificationConfigurationReason,
  getCommerceWhatsappChatConfigurationReason,
  getNormalizedCommerceStaffRecipients,
  isCommerceWhatsappQueueKind
} from "./commerceNotificationConfiguration.service";
import { ensureCommerceReviewInvitationJobForSentReceipt } from "./commerceReviewInvitationJob.service";
import { resolveCurrentBusinessWhatsappRecipient } from "./businessWasenderIdentity.service";

export interface EnqueueWasenderMessageInput {
  restaurantId?: string;
  businessId?: string;
  sessionId: string;
  to: string;
  type: OutboundMessageType;
  text?: string;
  documentUrl?: string;
  imageUrl?: string;
  caption?: string;
  apiKey?: string;
  idempotencyKey?: string;
  nextAttemptAt?: Date;
  metadata?: Record<string, unknown>;
}

const defaultSpacingMs = 5_000;
const workerIntervalMs = 1_000;
const defaultMaxAttempts = 5;
const staleSendingRecoveryMs = 5 * 60_000;
const recipientVerificationMaxBackoffMs = 15 * 60_000;
const maxConsecutiveRestaurantQueueSelections = 5;
let workerStarted = false;
let workerBusy = false;
let consecutiveRestaurantQueueSelections = 0;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const getRecipientVerificationRetryDelayMs = (
  attempts: number,
  providerRetryAfterMs?: number
): number => {
  if (providerRetryAfterMs) {
    return providerRetryAfterMs;
  }

  const exponent = Math.min(Math.max(attempts - 1, 0), 8);
  return Math.min(
    defaultSpacingMs * 2 ** exponent,
    recipientVerificationMaxBackoffMs
  );
};

const getErrorMessage = (result: WasenderSendResult): string =>
  result.error || (result.status ? `Wasender status ${result.status}` : "Wasender send failed");

const transactionalKinds = new Set([
  "owner_order_notification",
  "owner_order_cancelled_notification",
  "owner_order_cancellation_request_notification",
  "owner_order_amended_notification",
  "staff_order_notification",
  "staff_order_cancelled_notification",
  "staff_order_cancellation_request_notification",
  "staff_order_amended_notification",
  "owner_action_reminder",
  "staff_reminder",
  "owner_summary",
  "customer_order_confirmed_notification",
  "customer_order_rejected_notification",
  "customer_order_cancellation_resolution_notification",
  "receipt_delivery",
  "order_feedback_request",
  "order_feedback_reminder",
  "order_feedback_owner_notification",
  "order_feedback_staff_notification",
  "marketing_consent_request",
  "staff_direct_message",
  commercePaidOrderCustomerNotificationKind,
  commercePaidOrderReceiptNotificationKind,
  commercePurchaseReviewInvitationKind,
  commercePaidOrderStaffNotificationKind,
  commerceWhatsappChatReplyKind
]);

export const recoverableRecipientCancellationReasons = new Set([
  "no_current_whatsapp_recipient",
  "stale_username"
]);

export const isTransactionalQueuedMessage = (metadata?: Record<string, unknown>): boolean => {
  const kind = typeof metadata?.kind === "string" ? metadata.kind : undefined;

  return Boolean(kind && transactionalKinds.has(kind));
};

export const getQueuedOwnerOrderNotificationStaleReason = async (
  metadata?: Record<string, unknown>,
  queuedRestaurantId?: string
): Promise<string | null> => {
  const kind = typeof metadata?.kind === "string" ? metadata.kind : "";
  if (
    kind !== "owner_order_notification" &&
    kind !== "owner_order_amended_notification" &&
    kind !== "owner_order_cancellation_request_notification" &&
    kind !== "staff_order_notification" &&
    kind !== "staff_order_amended_notification" &&
    kind !== "staff_order_cancellation_request_notification"
  ) {
    return null;
  }

  const restaurantId =
    typeof metadata?.restaurantId === "string"
      ? metadata.restaurantId
      : queuedRestaurantId ?? "";
  const orderId = typeof metadata?.orderId === "string" ? metadata.orderId : "";
  if (!restaurantId || !orderId) {
    return "missing trusted order metadata";
  }

  const order = await Order.findOne({ _id: orderId, restaurantId });
  if (!order) {
    return "order no longer exists";
  }

  if (
    kind === "owner_order_cancellation_request_notification" ||
    kind === "staff_order_cancellation_request_notification"
  ) {
    return order.customerCancellationRequestStatus === "pending"
      ? null
      : "cancellation request is no longer pending";
  }

  if (
    order.status !== "awaiting_restaurant_confirmation" &&
    order.status !== "pending"
  ) {
    return `order status is ${order.status}`;
  }

  const expectedVersion = Number(metadata?.amendmentVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return "missing trusted amendment version";
  }

  const currentVersion = order.customerAmendmentVersion ?? 0;
  return expectedVersion === currentVersion
    ? null
    : `order amendment version is ${currentVersion}, expected ${expectedVersion}`;
};

export const isQueuedConversationalMessageStale = (
  metadata: Record<string, unknown> | undefined,
  session: (Pick<
    ICustomerSessionDocument,
    "_id" | "conversationVersion"
  > & CustomerDraftFollowUpState) | null
): boolean => {
  if (!metadata || isTransactionalQueuedMessage(metadata)) {
    return false;
  }

  if (metadata.purpose === "transactional") {
    return false;
  }

  if (!session) {
    return metadata.kind === "customer_follow_up";
  }

  const kind = typeof metadata.kind === "string" ? metadata.kind : "";
  const expectedVersion = Number(metadata.conversationVersion);
  const expectedStep = typeof metadata.expectedDraftStep === "string" ? metadata.expectedDraftStep : undefined;

  if (kind === "customer_follow_up") {
    const expectedSessionId =
      typeof metadata.sessionId === "string" ? metadata.sessionId : "";
    const expectedContextKey =
      typeof metadata.expectedDraftContextKey === "string"
        ? metadata.expectedDraftContextKey
        : "";

    if (!expectedSessionId || String(session._id) !== expectedSessionId) {
      return true;
    }

    if (
      expectedContextKey &&
      buildDraftFollowUpContextKey(session) !== expectedContextKey
    ) {
      return true;
    }
  }

  if (Number.isFinite(expectedVersion) && session.conversationVersion > expectedVersion) {
    return true;
  }

  if (expectedStep && session.currentStep !== expectedStep) {
    const purpose = typeof metadata.responsePurpose === "string" ? metadata.responsePurpose : "";

    if (kind === "customer_follow_up") {
      return true;
    }

    if (purpose === "greeting" && session.currentStep !== "idle") {
      return true;
    }
  }

  return false;
};

export const getQueuedOwnerActionReminderStaleReason = async (
  metadata: Record<string, unknown> | undefined,
  now = new Date(),
  queuedRecipientPhone?: string
): Promise<string | null> => {
  if (metadata?.kind !== "owner_action_reminder") {
    return null;
  }

  const restaurantId =
    typeof metadata.restaurantId === "string" ? metadata.restaurantId : "";
  const pendingActionId =
    typeof metadata.pendingActionId === "string" ? metadata.pendingActionId : "";
  const expectedVersion = Number(metadata.actionVersion);
  const expectedPhone =
    typeof metadata.pendingActionPhone === "string"
      ? normalizeGhanaPhone(metadata.pendingActionPhone)
      : "";
  const normalizedQueuedRecipient = queuedRecipientPhone
    ? normalizeGhanaPhone(queuedRecipientPhone)
    : "";

  if (
    !restaurantId ||
    !Types.ObjectId.isValid(pendingActionId) ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 1 ||
    !expectedPhone
  ) {
    return "invalid_metadata";
  }

  if (
    normalizedQueuedRecipient &&
    normalizedQueuedRecipient !== expectedPhone
  ) {
    return "queued_recipient_changed";
  }

  const action = await PendingAgentAction.findOne({
    _id: pendingActionId,
    restaurantId
  }).select(
    "senderPhone status actionVersion expiresAt createdAt"
  );

  if (!action) {
    return "pending_action_missing";
  }

  if (action.status !== "pending") {
    return `pending_action_${action.status}`;
  }

  if (action.expiresAt <= now) {
    return "pending_action_expired";
  }

  const currentVersion =
    Number.isInteger(action.actionVersion) && action.actionVersion > 0
      ? action.actionVersion
      : 1;

  if (currentVersion !== expectedVersion) {
    return "pending_action_version_changed";
  }

  const restaurant = await Restaurant.findOne({
    _id: restaurantId
  }).select("ownerName ownerPhone managerPhones managerContacts");

  if (!restaurant) {
    return "restaurant_missing";
  }

  const currentIdentity = resolveSenderIdentity(restaurant, action.senderPhone);

  if (!currentIdentity.verified) {
    return "pending_action_recipient_not_verified";
  }

  if (
    currentIdentity.role !== "owner" &&
    currentIdentity.role !== "manager"
  ) {
    return "pending_action_recipient_not_staff";
  }

  const resolvedPhone = normalizeGhanaPhone(currentIdentity.normalizedPhone);

  if (
    resolvedPhone !== expectedPhone ||
    (normalizedQueuedRecipient && resolvedPhone !== normalizedQueuedRecipient)
  ) {
    return "pending_action_recipient_changed";
  }

  const newerPendingAction = await PendingAgentAction.exists({
    restaurantId,
    senderPhone: action.senderPhone,
    status: "pending",
    expiresAt: { $gt: now },
    createdAt: { $gt: action.createdAt }
  });

  return newerPendingAction ? "pending_action_replaced" : null;
};

export const getQueuedCustomerCampaignStaleReason = async (
  metadata: Record<string, unknown> | undefined,
  now = new Date(),
  queuedRecipientPhone?: string,
  queuedSessionId?: string,
  queuedApiKey?: string
): Promise<string | null> => {
  if (metadata?.kind !== "customer_campaign") {
    return null;
  }

  const restaurantId =
    typeof metadata.restaurantId === "string"
      ? metadata.restaurantId
      : "";
  const campaignId =
    typeof metadata.campaignId === "string" ? metadata.campaignId : "";
  const campaignRecipientId =
    typeof metadata.campaignRecipientId === "string"
      ? metadata.campaignRecipientId
      : "";
  const campaignVersion = Number(metadata.campaignVersion);
  const customerPhone =
    typeof metadata.customerPhone === "string"
      ? normalizeWhatsappRecipient(metadata.customerPhone)
      : "";
  const queuedPhone = queuedRecipientPhone
    ? normalizeWhatsappRecipient(queuedRecipientPhone)
    : "";
  const customerKey =
    typeof metadata.customerKey === "string"
      ? metadata.customerKey.trim().toLowerCase()
      : "";

  if (
    !Types.ObjectId.isValid(restaurantId) ||
    !Types.ObjectId.isValid(campaignId) ||
    !Types.ObjectId.isValid(campaignRecipientId) ||
    !Number.isInteger(campaignVersion) ||
    campaignVersion < 1 ||
    !isValidWhatsappRecipient(customerPhone)
  ) {
    return "invalid_metadata";
  }

  if (!customerKey && queuedPhone && queuedPhone !== customerPhone) {
    return "queued_recipient_changed";
  }

  const campaign = await CustomerCampaign.findOne({
    _id: campaignId,
    restaurantId
  }).select(
    "status campaignVersion campaignType scheduledAt referencedMenuItemId attachmentType imageMenuItemId imageLabel +imageUrl +imagePublicId"
  );

  if (!campaign) {
    return "campaign_missing";
  }

  if (
    !["approved", "scheduled", "sending"].includes(campaign.status)
  ) {
    return `campaign_${campaign.status}`;
  }

  if (campaign.campaignVersion !== campaignVersion) {
    return "campaign_version_changed";
  }

  if (campaign.scheduledAt && campaign.scheduledAt > now) {
    return "campaign_not_due";
  }

  if (campaign.referencedMenuItemId) {
    const availableItem = await MenuItem.exists({
      _id: campaign.referencedMenuItemId,
      restaurantId,
      isAvailable: true
    });

    if (!availableItem) {
      return "campaign_referenced_item_unavailable";
    }
  }

  try {
    await validateCustomerCampaignMedia(restaurantId, campaign);
  } catch {
    return "campaign_image_stale";
  }

  const recipient = await CustomerCampaignRecipient.findOne({
    _id: campaignRecipientId,
    restaurantId,
    campaignId,
    campaignVersion,
    status: "pending"
  }).select("customerKey customerPhone campaignVersion");

  if (!recipient) {
    return "campaign_recipient_missing_or_not_pending";
  }

  if (recipient.campaignVersion !== campaignVersion) {
    return "campaign_recipient_version_changed";
  }

  if (
    customerKey
      ? recipient.customerKey !== customerKey
      : normalizeWhatsappRecipient(recipient.customerPhone) !== customerPhone
  ) {
    return "campaign_recipient_phone_changed";
  }

  const profile = await CustomerProfile.findOne(
    getCustomerIdentityFilter(
      restaurantId,
      customerPhone,
      customerKey || undefined
    )
  ).select("customerKey customerPhone marketingConsent isOptedOut");

  if (!profile) {
    return "customer_profile_missing";
  }

  if (
    customerKey
      ? profile.customerKey !== customerKey
      : normalizeWhatsappRecipient(profile.customerPhone) !== customerPhone
  ) {
    return "customer_profile_phone_changed";
  }

  if (
    profile.marketingConsent === false &&
    !campaignTypeAllowsNoConsent(campaign.campaignType)
  ) {
    return "marketing_consent_revoked";
  }

  if (profile.isOptedOut === true) {
    return "customer_opted_out";
  }

  const restaurant = await Restaurant.findOne({
    _id: restaurantId,
    status: { $in: ["trial", "active"] }
  }).select("+wasenderApiToken");

  if (!restaurant) {
    return "restaurant_inactive_or_missing";
  }

  if (
    !restaurant.wasenderSessionId?.trim() ||
    !restaurant.wasenderApiToken?.trim()
  ) {
    return "restaurant_wasender_credentials_missing";
  }

  if (
    queuedSessionId &&
    restaurant.wasenderSessionId !== queuedSessionId
  ) {
    return "restaurant_wasender_session_changed";
  }

  if (
    queuedApiKey &&
    restaurant.wasenderApiToken !== queuedApiKey
  ) {
    return "restaurant_wasender_token_changed";
  }

  return null;
};

export const getQueuedStaffDirectMessageStaleReason = async (
  metadata: Record<string, unknown> | undefined,
  queuedRecipientPhone?: string,
  queuedSessionId?: string,
  queuedApiKey?: string,
  queuedRestaurantId?: string
): Promise<string | null> => {
  if (metadata?.kind !== "staff_direct_message") {
    return null;
  }

  const restaurantId =
    typeof metadata.restaurantId === "string"
      ? metadata.restaurantId
      : queuedRestaurantId ?? "";
  const customerProfileId =
    typeof metadata.customerProfileId === "string"
      ? metadata.customerProfileId
      : "";
  const customerPhone =
    typeof metadata.customerPhone === "string"
      ? normalizeWhatsappRecipient(metadata.customerPhone)
      : "";
  const customerKey =
    typeof metadata.customerKey === "string"
      ? normalizeCustomerKey(metadata.customerKey, customerPhone)
      : "";
  const createdByPhone =
    typeof metadata.createdByPhone === "string"
      ? normalizeGhanaPhone(metadata.createdByPhone)
      : "";

  if (
    !Types.ObjectId.isValid(restaurantId) ||
    !Types.ObjectId.isValid(customerProfileId) ||
    !isValidWhatsappRecipient(customerPhone) ||
    !createdByPhone ||
    (typeof metadata.customerKey === "string" && !customerKey)
  ) {
    return "invalid_metadata";
  }

  if (queuedRestaurantId && queuedRestaurantId !== restaurantId) {
    return "queued_restaurant_changed";
  }

  const profile = await CustomerProfile.findOne({
    _id: customerProfileId,
    restaurantId
  }).select("customerKey customerPhone isOptedOut");

  if (!profile) {
    return "customer_profile_missing";
  }

  const currentPhone = normalizeWhatsappRecipient(profile.customerPhone);
  const currentKey = normalizeCustomerKey(
    profile.customerKey,
    currentPhone
  );
  if (
    customerKey
      ? currentKey !== customerKey
      : currentPhone !== customerPhone
  ) {
    return "customer_identity_changed";
  }

  if (profile.isOptedOut === true) {
    return "customer_opted_out";
  }

  if (
    !customerKey &&
    queuedRecipientPhone &&
    normalizeWhatsappRecipient(queuedRecipientPhone) !== customerPhone
  ) {
    return "queued_recipient_changed";
  }

  const restaurant = await Restaurant.findOne({
    _id: restaurantId,
    status: { $in: ["trial", "active"] }
  }).select(
    "+wasenderApiToken ownerName ownerPhone managerPhones managerContacts status wasenderSessionId"
  );

  if (!restaurant) {
    return "restaurant_inactive_or_missing";
  }

  const sender = resolveSenderIdentity(restaurant, createdByPhone);
  if (
    !sender.verified ||
    (sender.role !== "owner" && sender.role !== "manager")
  ) {
    return "staff_no_longer_authorized";
  }

  if (
    !restaurant.wasenderSessionId?.trim() ||
    !restaurant.wasenderApiToken?.trim()
  ) {
    return "restaurant_wasender_credentials_missing";
  }

  if (
    queuedSessionId &&
    queuedSessionId !== restaurant.wasenderSessionId
  ) {
    return "restaurant_wasender_session_changed";
  }

  if (
    queuedApiKey &&
    queuedApiKey !== restaurant.wasenderApiToken
  ) {
    return "restaurant_wasender_token_changed";
  }

  return null;
};

export const getQueuedMarketingConsentRequestStaleReason = async (
  metadata: Record<string, unknown> | undefined,
  queuedCustomerPhone: string
): Promise<string | null> => {
  const restaurantId =
    typeof metadata?.restaurantId === "string"
      ? metadata.restaurantId
      : undefined;
  const customerPhone =
    typeof metadata?.customerPhone === "string"
      ? normalizeWhatsappRecipient(metadata.customerPhone)
      : normalizeWhatsappRecipient(queuedCustomerPhone);
  const customerKey =
    typeof metadata?.customerKey === "string"
      ? metadata.customerKey
      : undefined;

  if (!restaurantId || !customerPhone) {
    return "invalid_consent_request_scope";
  }

  const profile = await CustomerProfile.findOne(
    getCustomerIdentityFilter(restaurantId, customerPhone, customerKey)
  ).select("marketingConsent isOptedOut");

  // A missing profile may mean the prompt was queued just before the profile
  // audit update completed. Do not cancel that narrow enqueue/mark race.
  if (!profile) {
    return null;
  }

  if (profile.isOptedOut === true) {
    return "customer_opted_out";
  }

  if (
    profile.marketingConsent === true ||
    profile.marketingConsent === false
  ) {
    return "marketing_preference_already_resolved";
  }

  return null;
};

export const getQueuedStaffReminderStaleReason = async (
  metadata: Record<string, unknown> | undefined,
  now = new Date(),
  queuedRecipientPhone?: string,
  queuedSessionId?: string,
  queuedApiKey?: string,
  queuedRestaurantId?: string
): Promise<string | null> => {
  if (metadata?.kind !== "staff_reminder") {
    return null;
  }

  const restaurantId =
    typeof metadata.restaurantId === "string" ? metadata.restaurantId : "";
  const createdByPhone =
    typeof metadata.createdByPhone === "string"
      ? normalizeGhanaPhone(metadata.createdByPhone)
      : "";
  const recipientPhone =
    typeof metadata.recipientPhone === "string"
      ? normalizeGhanaPhone(metadata.recipientPhone)
      : "";
  const createdByRole =
    metadata.createdByRole === "owner" || metadata.createdByRole === "manager"
      ? metadata.createdByRole
      : undefined;
  const recipientRole =
    metadata.recipientRole === "owner" || metadata.recipientRole === "manager"
      ? metadata.recipientRole
      : undefined;
  const scheduledFor =
    typeof metadata.scheduledFor === "string"
      ? new Date(metadata.scheduledFor)
      : undefined;
  const queuedPhone = queuedRecipientPhone
    ? normalizeGhanaPhone(queuedRecipientPhone)
    : "";

  if (
    !Types.ObjectId.isValid(restaurantId) ||
    !/^\+[1-9]\d{7,14}$/.test(createdByPhone) ||
    createdByPhone !== recipientPhone ||
    !createdByRole ||
    createdByRole !== recipientRole ||
    !scheduledFor ||
    Number.isNaN(scheduledFor.getTime())
  ) {
    return "invalid_metadata";
  }

  if (queuedRestaurantId && queuedRestaurantId !== restaurantId) {
    return "queued_restaurant_changed";
  }

  if (queuedPhone && queuedPhone !== recipientPhone) {
    return "queued_recipient_changed";
  }

  if (scheduledFor > now) {
    return "reminder_not_due";
  }

  const restaurant = await Restaurant.findOne({
    _id: restaurantId,
    status: { $in: ["trial", "active"] }
  }).select("+wasenderApiToken");

  if (!restaurant) {
    return "restaurant_inactive_or_missing";
  }

  if (
    !restaurant.wasenderSessionId?.trim() ||
    !restaurant.wasenderApiToken?.trim()
  ) {
    return "restaurant_wasender_credentials_missing";
  }

  if (queuedSessionId && restaurant.wasenderSessionId !== queuedSessionId) {
    return "restaurant_wasender_session_changed";
  }

  if (queuedApiKey && restaurant.wasenderApiToken !== queuedApiKey) {
    return "restaurant_wasender_token_changed";
  }

  const currentIdentity = resolveSenderIdentity(restaurant, createdByPhone);

  if (
    !currentIdentity.verified ||
    currentIdentity.normalizedPhone !== recipientPhone ||
    currentIdentity.role !== createdByRole
  ) {
    return "staff_recipient_removed_or_changed";
  }

  return null;
};

export const getWasenderRetryDelayMs = (result: WasenderSendResult): number => {
  const data = result.data;

  if (data && typeof data === "object" && "retry_after" in data) {
    const retryAfter = Number((data as { retry_after?: unknown }).retry_after);

    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      return Math.ceil(retryAfter * 1000);
    }
  }

  return defaultSpacingMs;
};

export const getSessionSpacingMs = (): number => {
  const configured = Number(process.env.WASENDER_SEND_SPACING_MS);

  return Number.isFinite(configured) && configured >= 0 ? configured : defaultSpacingMs;
};

export const getNextSessionSendAt = (
  lastSentAt: Date | undefined,
  now: Date,
  spacingMs = getSessionSpacingMs()
): Date | null => {
  if (!lastSentAt) {
    return null;
  }

  const nextSendAt = new Date(lastSentAt.getTime() + spacingMs);

  return nextSendAt > now ? nextSendAt : null;
};

export const updateOrderSideEffectAfterSend = async (
  message: IOutboundMessageDocument,
  result: WasenderSendResult
): Promise<void> => {
  const orderId = message.metadata?.orderId;
  const kind = message.metadata?.kind;
  const restaurantId =
    typeof message.metadata?.restaurantId === "string"
      ? message.metadata.restaurantId
      : message.restaurantId
        ? String(message.restaurantId)
        : "";

  if (
    typeof orderId !== "string" ||
    typeof kind !== "string" ||
    !restaurantId
  ) {
    return;
  }

  const now = new Date();
  const failureReason = result.success ? undefined : getErrorMessage(result);
  const isOwnerFallback = message.metadata?.recipientType === "owner";

  if (
    kind === "owner_order_notification" ||
    (kind === "staff_order_notification" && isOwnerFallback)
  ) {
    const providerMessageId = result.success ? extractWasenderProviderMessageId(result.data) : undefined;
    await Order.updateOne(
      { _id: orderId, restaurantId },
      result.success
        ? {
            $set: {
              ownerNotifiedAt: now,
              ...(providerMessageId ? { ownerNotificationProviderMessageId: providerMessageId } : {})
            },
            $unset: {
              ownerNotificationFailedAt: "",
              ownerNotificationFailureReason: ""
            }
          }
        : {
            $set: {
              ownerNotificationFailedAt: now,
              ownerNotificationFailureReason: failureReason
            }
          }
    );
    return;
  }

  if (
    kind === "owner_order_cancelled_notification" ||
    (kind === "staff_order_cancelled_notification" && isOwnerFallback)
  ) {
    await Order.updateOne(
      { _id: orderId, restaurantId },
      result.success
        ? {
            $set: { ownerCancellationNotifiedAt: now },
            $unset: {
              ownerCancellationNotificationFailedAt: "",
              ownerCancellationNotificationFailureReason: ""
            }
          }
        : {
            $set: {
              ownerCancellationNotificationFailedAt: now,
              ownerCancellationNotificationFailureReason: failureReason
            }
          }
    );
    return;
  }

  if (
    kind === "owner_order_cancellation_request_notification" ||
    (kind === "staff_order_cancellation_request_notification" && isOwnerFallback)
  ) {
    await Order.updateOne(
      { _id: orderId, restaurantId },
      result.success
        ? {
            $set: { ownerCancellationRequestNotifiedAt: now },
            $unset: {
              ownerCancellationRequestNotificationFailedAt: "",
              ownerCancellationRequestNotificationFailureReason: ""
            }
          }
        : {
            $set: {
              ownerCancellationRequestNotificationFailedAt: now,
              ownerCancellationRequestNotificationFailureReason: failureReason
            }
          }
    );
    return;
  }

  if (kind === "customer_order_cancellation_resolution_notification") {
    await Order.updateOne(
      { _id: orderId, restaurantId },
      result.success
        ? {
            $set: { customerCancellationResolutionNotifiedAt: now },
            $unset: {
              customerCancellationResolutionNotificationFailedAt: "",
              customerCancellationResolutionNotificationFailureReason: ""
            }
          }
        : {
            $set: {
              customerCancellationResolutionNotificationFailedAt: now,
              customerCancellationResolutionNotificationFailureReason: failureReason
            }
          }
    );
    return;
  }

  if (
    kind === "owner_order_amended_notification" ||
    (kind === "staff_order_amended_notification" && isOwnerFallback)
  ) {
    const amendmentVersion = Number(message.metadata?.amendmentVersion);

    if (!Number.isInteger(amendmentVersion) || amendmentVersion < 1) {
      return;
    }

    await Order.updateOne(
      { _id: orderId, restaurantId },
      result.success
        ? {
            $max: { ownerAmendmentNotifiedVersion: amendmentVersion },
            $unset: {
              ownerAmendmentNotificationFailedAt: "",
              ownerAmendmentNotificationFailureReason: ""
            }
          }
        : {
            $set: {
              ownerAmendmentNotificationFailedAt: now,
              ownerAmendmentNotificationFailureReason: failureReason
            }
          }
    );
    return;
  }

  if (kind === "customer_order_confirmed_notification") {
    await Order.updateOne(
      { _id: orderId, restaurantId },
      result.success
        ? {
            $set: { customerConfirmedNotificationSentAt: now },
            $unset: {
              customerNotificationFailedAt: "",
              customerNotificationFailureReason: ""
            }
          }
        : {
            $set: {
              customerNotificationFailedAt: now,
              customerNotificationFailureReason: failureReason
            }
          }
    );

    if (result.success) {
      try {
        await scheduleOrderFeedbackFollowUp(
          restaurantId,
          orderId,
          { enqueueMessage: enqueueWasenderMessage },
          now
        );
      } catch (error) {
        console.error("Order feedback scheduling after acceptance send failed", {
          restaurantId,
          orderId,
          error:
            error instanceof Error
              ? error.message
              : "Unknown order feedback scheduling error"
        });
      }
    }
    return;
  }

  if (kind === "customer_order_rejected_notification") {
    await Order.updateOne(
      { _id: orderId, restaurantId },
      result.success
        ? {
            $set: { rejectionNotificationSentAt: now },
            $unset: {
              customerNotificationFailedAt: "",
              customerNotificationFailureReason: ""
            }
          }
        : {
            $set: {
              customerNotificationFailedAt: now,
              customerNotificationFailureReason: failureReason
            }
          }
    );
    return;
  }

  if (kind === "receipt_delivery") {
    console.info(result.success ? "Receipt document sent" : "Receipt document failed", {
      orderId,
      orderNumber: message.metadata?.orderNumber,
      queueMessageId: String(message._id),
      status: result.status,
      error: failureReason
    });
    await Order.updateOne(
      { _id: orderId, restaurantId },
      result.success
        ? {
            $set: { receiptSentAt: now },
            $unset: {
              receiptDeliveryFailedAt: "",
              receiptDeliveryFailureReason: ""
            }
          }
        : {
            $set: {
              receiptDeliveryFailedAt: now,
              receiptDeliveryFailureReason: failureReason
            }
          }
    );

    if (result.success) {
      try {
        await scheduleOrderFeedbackFollowUp(
          restaurantId,
          orderId,
          { enqueueMessage: enqueueWasenderMessage },
          now
        );
      } catch (error) {
        console.error("Order feedback scheduling after receipt send failed", {
          restaurantId,
          orderId,
          error:
            error instanceof Error
              ? error.message
              : "Unknown order feedback scheduling error"
        });
      }
    }
  }
};

const updateCampaignRecipientAfterAttempt = async (
  message: IOutboundMessageDocument,
  result: WasenderSendResult,
  finalFailure: boolean
): Promise<void> => {
  if (message.metadata?.kind !== "customer_campaign") {
    return;
  }

  const restaurantId =
    typeof message.metadata.restaurantId === "string"
      ? message.metadata.restaurantId
      : "";
  const campaignId =
    typeof message.metadata.campaignId === "string"
      ? message.metadata.campaignId
      : "";
  const campaignRecipientId =
    typeof message.metadata.campaignRecipientId === "string"
      ? message.metadata.campaignRecipientId
      : "";
  const campaignVersion = Number(message.metadata.campaignVersion);

  if (
    !restaurantId ||
    !campaignId ||
    !campaignRecipientId ||
    !Number.isInteger(campaignVersion) ||
    campaignVersion < 1
  ) {
    return;
  }

  const attemptedAt = new Date();

  if (result.success) {
    await CustomerCampaignRecipient.updateOne(
      {
        _id: campaignRecipientId,
        restaurantId,
        campaignId,
        campaignVersion,
        status: "pending"
      },
      {
        $set: {
          status: "sent",
          attemptedAt,
          sentAt: attemptedAt,
          ...(extractWasenderProviderMessageId(result.data)
            ? {
                providerMessageId:
                  extractWasenderProviderMessageId(result.data)
              }
            : {})
        },
        $unset: {
          failureReason: ""
        }
      }
    );
    await updateCustomerCampaignAggregate(
      restaurantId,
      campaignId,
      campaignVersion,
      attemptedAt
    );
    return;
  }

  if (finalFailure) {
    await CustomerCampaignRecipient.updateOne(
      {
        _id: campaignRecipientId,
        restaurantId,
        campaignId,
        campaignVersion,
        status: "pending"
      },
      {
        $set: {
          status: "failed",
          attemptedAt,
          failureReason: getErrorMessage(result)
        }
      }
    );
    await updateCustomerCampaignAggregate(
      restaurantId,
      campaignId,
      campaignVersion,
      attemptedAt
    );
    return;
  }

  await CustomerCampaignRecipient.updateOne(
    {
      _id: campaignRecipientId,
      restaurantId,
      campaignId,
      campaignVersion,
      status: "pending"
    },
    {
      $set: {
        attemptedAt
      }
    }
  );
};

const cancelStaleCampaignRecipient = async (
  metadata: Record<string, unknown>,
  staleReason: string,
  now = new Date()
): Promise<void> => {
  const restaurantId =
    typeof metadata.restaurantId === "string"
      ? metadata.restaurantId
      : "";
  const campaignId =
    typeof metadata.campaignId === "string" ? metadata.campaignId : "";
  const campaignRecipientId =
    typeof metadata.campaignRecipientId === "string"
      ? metadata.campaignRecipientId
      : "";
  const campaignVersion = Number(metadata.campaignVersion);

  if (
    !restaurantId ||
    !campaignId ||
    !campaignRecipientId ||
    !Number.isInteger(campaignVersion) ||
    campaignVersion < 1
  ) {
    return;
  }

  await CustomerCampaignRecipient.updateOne(
    {
      _id: campaignRecipientId,
      restaurantId,
      campaignId,
      campaignVersion,
      status: "pending"
    },
    {
      $set: {
        status: "cancelled",
        attemptedAt: now,
        failureReason: `Stale customer campaign message: ${staleReason}`
      }
    }
  );
  await updateCustomerCampaignAggregate(
    restaurantId,
    campaignId,
    campaignVersion,
    now
  );
};

export const enqueueWasenderMessage = async (
  input: EnqueueWasenderMessageInput
): Promise<IOutboundMessageDocument> => {
  const idempotencyFilter = input.idempotencyKey
    ? {
        idempotencyKey: input.idempotencyKey,
        ...(input.restaurantId ? { restaurantId: input.restaurantId } : {}),
        ...(input.businessId ? { businessId: input.businessId } : {})
      }
    : undefined;

  if (idempotencyFilter) {
    const existing = await OutboundMessage.findOne(idempotencyFilter).select("+apiKey");

    if (existing) {
      if (
        existing.status === "cancelled" &&
        recoverableRecipientCancellationReasons.has(existing.lastError ?? "")
      ) {
        const metadata = { ...existing.metadata, ...input.metadata };
        const restaurantId =
          input.restaurantId ??
          (existing.restaurantId ? String(existing.restaurantId) : undefined);
        const customerKey =
          typeof metadata.customerKey === "string"
            ? metadata.customerKey
            : undefined;

        if (restaurantId && customerKey) {
          const resolution = await resolveCurrentWhatsappRecipientResult({
            restaurantId,
            customerKey,
            fallbackAddress: input.to || existing.to,
            apiKey: input.apiKey ?? existing.apiKey,
            verifyUsername: true
          });

          if (resolution.resolved && resolution.recipient) {
            existing.sessionId = input.sessionId;
            existing.to = resolution.recipient;
            existing.type = input.type;
            existing.text = input.text;
            existing.documentUrl = input.documentUrl;
            existing.imageUrl = input.imageUrl;
            existing.caption = input.caption;
            existing.apiKey = input.apiKey ?? existing.apiKey;
            existing.status = "pending";
            existing.attempts = 0;
            existing.nextAttemptAt = input.nextAttemptAt ?? new Date();
            existing.lastError = undefined;
            existing.lastStatus = undefined;
            existing.providerData = undefined;
            existing.providerMessageId = undefined;
            existing.lastAttemptAt = undefined;
            existing.sentAt = undefined;
            existing.metadata = {
              ...metadata,
              customerPhone: resolution.recipient,
              customerKey
            };
            await existing.save();
          }
        }
      }

      return existing;
    }
  }

  try {
    return await OutboundMessage.create({
      restaurantId: input.restaurantId,
      businessId: input.businessId,
      sessionId: input.sessionId,
      to: input.to,
      type: input.type,
      text: input.text,
      documentUrl: input.documentUrl,
      imageUrl: input.imageUrl,
      caption: input.caption,
      apiKey: input.apiKey,
      status: "pending",
      attempts: 0,
      maxAttempts: defaultMaxAttempts,
      nextAttemptAt: input.nextAttemptAt ?? new Date(),
      idempotencyKey: input.idempotencyKey,
      metadata: input.metadata
    });
  } catch (error) {
    if (
      idempotencyFilter &&
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: number }).code === 11000
    ) {
      const existing = await OutboundMessage.findOne(idempotencyFilter).select("+apiKey");

      if (existing) {
        return existing;
      }
    }

    throw error;
  }
};

export interface SendQueuedWasenderMessageDependencies {
  sendText?: typeof sendTextMessage;
  sendDocument?: typeof sendDocumentMessage;
  sendImage?: typeof sendImageMessage;
}

export const sendQueuedWasenderMessage = async (
  message: IOutboundMessageDocument,
  dependencies: SendQueuedWasenderMessageDependencies = {}
): Promise<WasenderSendResult> => {
  if (message.type === "document") {
    if (!message.documentUrl) {
      return {
        success: false,
        error: "Queued document message is missing documentUrl"
      };
    }

    return (dependencies.sendDocument ?? sendDocumentMessage)(
      message.sessionId,
      message.to,
      message.documentUrl,
      message.caption,
      { apiKey: message.apiKey }
    );
  }

  if (message.type === "image") {
    if (!message.imageUrl) {
      return {
        success: false,
        error: "Queued image message is missing imageUrl"
      };
    }

    return (dependencies.sendImage ?? sendImageMessage)(
      message.sessionId,
      message.to,
      message.imageUrl,
      message.caption,
      { apiKey: message.apiKey }
    );
  }

  return (dependencies.sendText ?? sendTextMessage)(message.sessionId, message.to, message.text ?? "", {
    apiKey: message.apiKey
  });
};

export interface ProcessQueuedWasenderMessageDependencies {
  sendMessage?: (message: IOutboundMessageDocument) => Promise<WasenderSendResult>;
  enqueueMessage?: typeof enqueueWasenderMessage;
}

const resolveQueuedCustomerIdentity = async (
  message: IOutboundMessageDocument
): Promise<{
  restaurantId?: string;
  customerKey?: string;
  fallbackAddress: string;
}> => {
  const restaurantId =
    typeof message.metadata?.restaurantId === "string"
      ? message.metadata.restaurantId
      : message.restaurantId
        ? String(message.restaurantId)
        : undefined;
  let customerKey =
    typeof message.metadata?.customerKey === "string"
      ? message.metadata.customerKey
      : undefined;
  let fallbackAddress = message.to;
  const orderId =
    typeof message.metadata?.orderId === "string"
      ? message.metadata.orderId
      : undefined;

  // This also protects customer messages queued before customerKey was added
  // to their metadata, provided the queue item has trusted tenant/order scope.
  if (
    !customerKey &&
    message.metadata?.recipientType === "customer" &&
    restaurantId &&
    orderId &&
    Types.ObjectId.isValid(restaurantId) &&
    Types.ObjectId.isValid(orderId)
  ) {
    const order = await Order.findOne({ _id: orderId, restaurantId }).select(
      "customerKey customerPhone"
    );
    customerKey = order?.customerKey;
    fallbackAddress = order?.customerPhone || fallbackAddress;
  }

  return { restaurantId, customerKey, fallbackAddress };
};

export const refreshQueuedCustomerRecipient = async (
  message: IOutboundMessageDocument
): Promise<{
  safe: boolean;
  reason?: string;
  recipient?: string;
  temporary?: boolean;
  retryAfterMs?: number;
}> => {
  let reference: Awaited<ReturnType<typeof resolveQueuedCustomerIdentity>>;

  try {
    reference = await resolveQueuedCustomerIdentity(message);
  } catch {
    return {
      safe: false,
      reason: "no_current_whatsapp_recipient"
    };
  }

  if (!reference.restaurantId || !reference.customerKey) {
    return { safe: true, recipient: message.to };
  }

  const resolution = await resolveCurrentWhatsappRecipientResult({
    restaurantId: reference.restaurantId,
    customerKey: reference.customerKey,
    fallbackAddress: reference.fallbackAddress,
    apiKey: message.apiKey,
    verifyUsername: true
  });

  if (!resolution.resolved || !resolution.recipient) {
    return {
      safe: false,
      reason: resolution.reason,
      temporary: resolution.temporary,
      retryAfterMs: resolution.retryAfterMs
    };
  }

  if (message.to !== resolution.recipient) {
    message.to = resolution.recipient;
    message.metadata = {
      ...message.metadata,
      customerPhone: resolution.recipient,
      customerKey: reference.customerKey
    };
  }

  return {
    safe: true,
    recipient: resolution.recipient,
    reason: resolution.reason
  };
};

type CommerceQueueRefreshResult =
  | { outcome: "ready" }
  | { outcome: "defer"; reason: string }
  | { outcome: "cancel"; reason: string };

const getCommerceQueueDeferralDelayMs = (
  metadata?: Record<string, unknown>
): number => {
  const deferrals = Number(metadata?.commerceDeferrals ?? 0);
  const exponent = Math.min(
    Math.max(Number.isInteger(deferrals) ? deferrals : 0, 0),
    8
  );
  return Math.min(30_000 * 2 ** exponent, 15 * 60_000);
};

const refreshQueuedCommerceNotification = async (
  message: IOutboundMessageDocument
): Promise<CommerceQueueRefreshResult> => {
  const kind = message.metadata?.kind;
  if (!isCommerceWhatsappQueueKind(kind)) {
    return { outcome: "ready" };
  }

  const queuedBusinessId = message.businessId ? String(message.businessId) : "";
  const metadataBusinessId =
    typeof message.metadata?.businessId === "string"
      ? message.metadata.businessId
      : "";
  if (
    !queuedBusinessId ||
    !metadataBusinessId ||
    queuedBusinessId !== metadataBusinessId ||
    !Types.ObjectId.isValid(queuedBusinessId)
  ) {
    return { outcome: "cancel", reason: "invalid_commerce_queue_scope" };
  }

  const business = await Business.findById(queuedBusinessId).select(
    "+whatsappIntegration.wasenderApiToken"
  );

  if (!business) {
    return { outcome: "cancel", reason: "business_missing" };
  }

  if (kind === commerceWhatsappChatReplyKind) {
    if (business.type !== "ecommerce" || business.status === "cancelled") {
      return { outcome: "cancel", reason: "business_no_longer_eligible" };
    }
    const configurationReason = getCommerceWhatsappChatConfigurationReason(business);
    if (configurationReason) {
      return { outcome: "defer", reason: configurationReason };
    }

    const expectedRecipient = normalizeWhatsappRecipient(
      typeof message.metadata?.recipientAddress === "string"
        ? message.metadata.recipientAddress
        : ""
    );
    const queuedRecipient = normalizeWhatsappRecipient(message.to);
    const customerKey =
      typeof message.metadata?.customerKey === "string"
        ? message.metadata.customerKey
        : "";
    const identitySessionId =
      typeof message.metadata?.identitySessionId === "string"
        ? message.metadata.identitySessionId
        : "";
    if (
      !isValidWhatsappRecipient(expectedRecipient) ||
      queuedRecipient !== expectedRecipient ||
      !customerKey ||
      identitySessionId !== business.whatsappIntegration!.wasenderSessionId
    ) {
      return { outcome: "cancel", reason: "chat_recipient_invalid" };
    }

    const recipientResolution = await resolveCurrentBusinessWhatsappRecipient({
      businessId: queuedBusinessId,
      sessionId: identitySessionId,
      customerKey,
      fallbackAddress: expectedRecipient,
      apiKey: business.whatsappIntegration!.wasenderApiToken!
    });
    if (!recipientResolution.resolved || !recipientResolution.recipient) {
      return recipientResolution.temporary
        ? { outcome: "defer", reason: recipientResolution.reason }
        : { outcome: "cancel", reason: recipientResolution.reason };
    }

    message.to = recipientResolution.recipient;
    message.metadata = {
      ...message.metadata,
      recipientAddress: recipientResolution.recipient,
      customerKey
    };
    message.sessionId = business.whatsappIntegration!.wasenderSessionId!;
    message.apiKey = business.whatsappIntegration!.wasenderApiToken!;
    return { outcome: "ready" };
  }

  const commerceEventId =
    typeof message.metadata?.commerceEventId === "string"
      ? message.metadata.commerceEventId
      : "";
  if (!commerceEventId) {
    return { outcome: "cancel", reason: "invalid_commerce_queue_scope" };
  }
  const event = await CommercePaidOrderEvent.findOne({
    businessId: queuedBusinessId,
    eventId: commerceEventId
  });

  if (!event) {
    return { outcome: "cancel", reason: "commerce_event_missing" };
  }
  if (event.status !== "enqueued") {
    return { outcome: "defer", reason: "commerce_event_enqueue_incomplete" };
  }
  if (business.type !== "ecommerce" || business.status === "cancelled") {
    return { outcome: "cancel", reason: "business_no_longer_eligible" };
  }

  const configurationReason = getCommerceNotificationConfigurationReason(business);
  if (configurationReason) {
    return { outcome: "defer", reason: configurationReason };
  }

  const normalizedQueuedRecipient = normalizeGhanaPhone(message.to);
  if (
    kind === commercePaidOrderCustomerNotificationKind ||
    kind === commercePaidOrderReceiptNotificationKind ||
    kind === commercePurchaseReviewInvitationKind
  ) {
    const customerRecipient = normalizeGhanaPhone(event.order.customer.phone);
    if (!event.order.customer.whatsappConsent) {
      return { outcome: "cancel", reason: "customer_whatsapp_consent_missing" };
    }
    if (
      !isWhatsappPhoneAddress(customerRecipient) ||
      normalizedQueuedRecipient !== customerRecipient
    ) {
      return { outcome: "cancel", reason: "customer_recipient_changed_or_invalid" };
    }
    message.to = customerRecipient;

    if (kind === commercePaidOrderReceiptNotificationKind) {
      const commerceReceiptId =
        typeof message.metadata?.commerceReceiptId === "string"
          ? message.metadata.commerceReceiptId
          : "";
      if (!commerceReceiptId || !Types.ObjectId.isValid(commerceReceiptId)) {
        return { outcome: "cancel", reason: "receipt_metadata_invalid" };
      }
      const receipt = await CommerceReceipt.findOne({
        _id: commerceReceiptId,
        businessId: queuedBusinessId,
        commerceEventId
      });
      if (!receipt) {
        return { outcome: "cancel", reason: "receipt_ownership_mismatch" };
      }
      if (!receipt.pdfAssetUrl || !receipt.pdfAssetPublicId) {
        return { outcome: "defer", reason: "receipt_pdf_not_ready" };
      }
      message.documentUrl = receipt.pdfAssetUrl;
    } else if (kind === commercePurchaseReviewInvitationKind) {
      const jobId =
        typeof message.metadata?.commerceReviewInvitationJobId === "string"
          ? message.metadata.commerceReviewInvitationJobId
          : "";
      if (!jobId || !Types.ObjectId.isValid(jobId)) {
        return { outcome: "cancel", reason: "review_invitation_metadata_invalid" };
      }
      const job = await CommerceReviewInvitationJob.findOne({
        _id: jobId,
        businessId: queuedBusinessId,
        commerceEventId,
        externalOrderId: event.order.externalOrderId,
        customerRecipient
      });
      if (!job) {
        return { outcome: "cancel", reason: "review_invitation_scope_invalid" };
      }
      if (job.status === "failed" || job.status === "skipped") {
        return { outcome: "cancel", reason: "review_invitation_no_longer_sendable" };
      }
      if (job.status === "sent") {
        return { outcome: "cancel", reason: "review_invitation_already_sent" };
      }
      if (job.status === "processing") {
        return { outcome: "defer", reason: "review_invitation_not_ready" };
      }
      if (!job.invitationOutboundMessageId) {
        return { outcome: "defer", reason: "review_invitation_not_ready" };
      }
      if (
        job.status !== "enqueued" ||
        String(job.invitationOutboundMessageId) !== String(message._id)
      ) {
        return { outcome: "cancel", reason: "review_invitation_no_longer_sendable" };
      }
      const sentReceiptExists = await OutboundMessage.exists({
        _id: job.receiptOutboundMessageId,
        businessId: queuedBusinessId,
        status: "sent",
        "metadata.kind": commercePaidOrderReceiptNotificationKind,
        "metadata.reviewInvitationEligible": true
      });
      if (!sentReceiptExists) {
        return { outcome: "cancel", reason: "receipt_message_not_sent" };
      }
    }
  } else {
    const currentRecipients = getNormalizedCommerceStaffRecipients(business);
    if (
      !isWhatsappPhoneAddress(normalizedQueuedRecipient) ||
      !currentRecipients.includes(normalizedQueuedRecipient)
    ) {
      return { outcome: "cancel", reason: "staff_recipient_removed_or_changed" };
    }
    message.to = normalizedQueuedRecipient;
  }

  message.sessionId = business.whatsappIntegration!.wasenderSessionId!;
  message.apiKey = business.whatsappIntegration!.wasenderApiToken!;
  return { outcome: "ready" };
};

export const processNextQueuedWasenderMessage = async (
  dependencies: ProcessQueuedWasenderMessageDependencies = {}
): Promise<boolean> => {
  const now = new Date();
  const dueFilter = {
    status: "pending" as const,
    nextAttemptAt: { $lte: now }
  };
  const [restaurantCandidate, businessCandidate] = await Promise.all([
    OutboundMessage.findOne({
      ...dueFilter,
      businessId: { $exists: false }
    })
      .sort({ nextAttemptAt: 1, createdAt: 1 })
      .select("+apiKey +imageUrl"),
    OutboundMessage.findOne({
      ...dueFilter,
      businessId: { $exists: true }
    })
      .sort({ nextAttemptAt: 1, createdAt: 1 })
      .select("+apiKey +imageUrl")
  ]);
  const shouldSelectBusiness = Boolean(
    businessCandidate &&
      (!restaurantCandidate ||
        consecutiveRestaurantQueueSelections >=
          maxConsecutiveRestaurantQueueSelections)
  );
  const candidate = shouldSelectBusiness
    ? businessCandidate
    : restaurantCandidate ?? businessCandidate;

  if (!candidate) {
    return false;
  }

  if (candidate.businessId) {
    consecutiveRestaurantQueueSelections = 0;
  } else {
    consecutiveRestaurantQueueSelections = Math.min(
      consecutiveRestaurantQueueSelections + 1,
      maxConsecutiveRestaurantQueueSelections
    );
  }

  const candidateIsCommerce = isCommerceWhatsappQueueKind(
    candidate.metadata?.kind
  );
  const spacingMs = getSessionSpacingMs();
  if (!candidateIsCommerce) {
    const lastSent = await OutboundMessage.findOne({
      sessionId: candidate.sessionId,
      status: "sent",
      sentAt: { $exists: true }
    })
      .sort({ sentAt: -1 })
      .select("sentAt");

    const nextSessionSendAt = getNextSessionSendAt(
      lastSent?.sentAt,
      new Date(),
      spacingMs
    );

    if (nextSessionSendAt) {
      candidate.nextAttemptAt = nextSessionSendAt;
      await candidate.save();
      return true;
    }
  }

  const locked = await OutboundMessage.findOneAndUpdate(
    {
      _id: candidate._id,
      status: "pending",
      nextAttemptAt: { $lte: new Date() }
    },
    {
      $set: {
        status: "sending",
        lastAttemptAt: new Date()
      },
      $inc: {
        attempts: 1
      }
    },
    {
      new: true
    }
  ).select("+apiKey +imageUrl");

  if (!locked) {
    return true;
  }

  const commerceMessage = isCommerceWhatsappQueueKind(
    locked.metadata?.kind
  );
  if (commerceMessage) {
    let refreshed: CommerceQueueRefreshResult;
    try {
      refreshed = await refreshQueuedCommerceNotification(locked);
    } catch {
      refreshed = {
        outcome: "defer",
        reason: "commerce_notification_revalidation_failed"
      };
    }
    if (refreshed.outcome === "cancel") {
      locked.status = "cancelled";
      locked.lastError = refreshed.reason;
      await locked.save();
      if (locked.metadata?.kind === commercePurchaseReviewInvitationKind) {
        const jobId = locked.metadata.commerceReviewInvitationJobId;
        if (typeof jobId === "string" && Types.ObjectId.isValid(jobId)) {
          await CommerceReviewInvitationJob.updateOne(
            {
              _id: jobId,
              businessId: locked.businessId,
              status: "enqueued"
            },
            {
              $set: {
                status: "failed",
                completedAt: new Date(),
                lastErrorCode: refreshed.reason.toUpperCase()
              }
            }
          );
        }
      }
      console.info("Stale commerce notification cancelled", {
        businessId: locked.businessId ? String(locked.businessId) : undefined,
        commerceEventId: locked.metadata?.commerceEventId,
        kind: locked.metadata?.kind,
        queueMessageId: String(locked._id),
        reason: refreshed.reason
      });
      return true;
    }
    if (refreshed.outcome === "defer") {
      const delayMs = getCommerceQueueDeferralDelayMs(locked.metadata);
      const deferrals = Number(locked.metadata?.commerceDeferrals ?? 0);
      locked.status = "pending";
      locked.attempts = Math.max(locked.attempts - 1, 0);
      locked.nextAttemptAt = new Date(Date.now() + delayMs);
      locked.lastError = refreshed.reason;
      locked.metadata = {
        ...locked.metadata,
        commerceDeferrals:
          (Number.isInteger(deferrals) && deferrals >= 0 ? deferrals : 0) + 1
      };
      await locked.save();
      return true;
    }

    const lastSent = await OutboundMessage.findOne({
      sessionId: locked.sessionId,
      status: "sent",
      sentAt: { $exists: true }
    })
      .sort({ sentAt: -1 })
      .select("sentAt");
    const nextSessionSendAt = getNextSessionSendAt(
      lastSent?.sentAt,
      new Date(),
      spacingMs
    );
    if (nextSessionSendAt) {
      locked.status = "pending";
      locked.attempts = Math.max(locked.attempts - 1, 0);
      locked.nextAttemptAt = nextSessionSendAt;
      await locked.save();
      return true;
    }
  }

  if (
    locked.metadata?.kind === "owner_order_notification" ||
    locked.metadata?.kind === "owner_order_amended_notification" ||
    locked.metadata?.kind === "owner_order_cancellation_request_notification" ||
    locked.metadata?.kind === "staff_order_notification" ||
    locked.metadata?.kind === "staff_order_amended_notification" ||
    locked.metadata?.kind === "staff_order_cancellation_request_notification"
  ) {
    const staleReason = await getQueuedOwnerOrderNotificationStaleReason(
      locked.metadata,
      locked.restaurantId ? String(locked.restaurantId) : undefined
    );

    if (staleReason) {
      locked.status = "cancelled";
      locked.lastError = `Stale staff order message: ${staleReason}`;
      await locked.save();
      console.info("Stale staff order message cancelled", {
        restaurantId: locked.metadata.restaurantId,
        orderId: locked.metadata.orderId,
        queueMessageId: String(locked._id),
        staleReason
      });
      return true;
    }
  } else if (
    locked.metadata?.kind === "order_feedback_request" ||
    locked.metadata?.kind === "order_feedback_reminder"
  ) {
    const staleReason = await getQueuedOrderFeedbackStaleReason(locked);

    if (staleReason) {
      locked.status = "cancelled";
      locked.lastError = `Stale order feedback message: ${staleReason}`;
      await locked.save();
      console.info("Stale order feedback message cancelled", {
        restaurantId: locked.metadata.restaurantId,
        orderId: locked.metadata.orderId,
        queueMessageId: String(locked._id),
        staleReason
      });
      return true;
    }
  } else if (locked.metadata?.kind === "marketing_consent_request") {
    const staleReason =
      await getQueuedMarketingConsentRequestStaleReason(
        locked.metadata,
        locked.to
      );

    if (staleReason) {
      locked.status = "cancelled";
      locked.lastError = `Stale marketing consent request: ${staleReason}`;
      await locked.save();
      console.info("Stale marketing consent request cancelled", {
        restaurantId: locked.metadata.restaurantId,
        orderId: locked.metadata.orderId,
        queueMessageId: String(locked._id),
        staleReason
      });
      return true;
    }
  } else if (locked.metadata?.kind === "owner_action_reminder") {
    const staleReason = await getQueuedOwnerActionReminderStaleReason(
      locked.metadata,
      new Date(),
      locked.to
    );

    if (staleReason) {
      locked.status = "cancelled";
      locked.lastError = `Stale owner pending-action reminder: ${staleReason}`;
      await locked.save();
      console.info("Stale owner pending-action reminder cancelled", {
        restaurantId: locked.metadata.restaurantId,
        pendingActionId: locked.metadata.pendingActionId,
        queueMessageId: String(locked._id),
        staleReason
      });
      return true;
    }
  } else if (locked.metadata?.kind === "staff_reminder") {
    const staleReason = await getQueuedStaffReminderStaleReason(
      locked.metadata,
      new Date(),
      locked.to,
      locked.sessionId,
      locked.apiKey,
      locked.restaurantId ? String(locked.restaurantId) : undefined
    );

    if (staleReason) {
      locked.status = "cancelled";
      locked.lastError = `Stale staff reminder: ${staleReason}`;
      await locked.save();
      console.info("Stale staff reminder cancelled", {
        restaurantId: locked.metadata.restaurantId,
        queueMessageId: String(locked._id),
        staleReason
      });
      return true;
    }
  } else if (locked.metadata?.kind === "staff_direct_message") {
    const staleReason = await getQueuedStaffDirectMessageStaleReason(
      locked.metadata,
      locked.to,
      locked.sessionId,
      locked.apiKey,
      locked.restaurantId ? String(locked.restaurantId) : undefined
    );

    if (staleReason) {
      locked.status = "cancelled";
      locked.lastError = `Stale staff direct message: ${staleReason}`;
      await locked.save();
      console.info("Stale staff direct message cancelled", {
        restaurantId: locked.metadata.restaurantId,
        customerProfileId: locked.metadata.customerProfileId,
        queueMessageId: String(locked._id),
        staleReason
      });
      return true;
    }
  } else if (locked.metadata?.kind === "customer_campaign") {
    const staleReason = await getQueuedCustomerCampaignStaleReason(
      locked.metadata,
      new Date(),
      locked.to,
      locked.sessionId,
      locked.apiKey
    );

    if (staleReason) {
      locked.status = "cancelled";
      locked.lastError = `Stale customer campaign message: ${staleReason}`;
      await locked.save();
      await cancelStaleCampaignRecipient(
        locked.metadata,
        staleReason
      );
      console.info("Stale customer campaign message cancelled", {
        restaurantId: locked.metadata.restaurantId,
        campaignId: locked.metadata.campaignId,
        campaignRecipientId:
          locked.metadata.campaignRecipientId,
        queueMessageId: String(locked._id),
        staleReason
      });
      return true;
    }
  } else if (!isTransactionalQueuedMessage(locked.metadata)) {
    const restaurantId =
      typeof locked.metadata?.restaurantId === "string"
        ? locked.metadata.restaurantId
        : locked.restaurantId
          ? String(locked.restaurantId)
          : undefined;
    const customerPhone =
      typeof locked.metadata?.customerPhone === "string" ? locked.metadata.customerPhone : locked.to;
    const customerKey =
      typeof locked.metadata?.customerKey === "string"
        ? locked.metadata.customerKey
        : undefined;
    const session =
      restaurantId && customerPhone
        ? await CustomerSession.findOne(
            getCustomerIdentityFilter(
              restaurantId,
              customerPhone,
              customerKey
            )
          ).select(
            "_id conversationVersion currentStep cartItems pendingMenuItemId pendingCategoryId orderType deliveryFee"
          )
        : null;

    if (isQueuedConversationalMessageStale(locked.metadata, session)) {
      locked.status = "cancelled";
      locked.lastError = "Stale conversational reply superseded by a newer customer turn";
      await locked.save();
      console.info("Stale conversational reply cancelled", {
        restaurantId,
        customerPhone,
        queueMessageId: String(locked._id),
        conversationVersion: locked.metadata?.conversationVersion,
        expectedDraftStep: locked.metadata?.expectedDraftStep,
        currentDraftStep: session?.currentStep
      });
      return true;
    }
  }

  const refreshedRecipient: Awaited<
    ReturnType<typeof refreshQueuedCustomerRecipient>
  > = commerceMessage
    ? { safe: true, recipient: locked.to }
    : await refreshQueuedCustomerRecipient(locked);
  if (!refreshedRecipient.safe) {
    if (refreshedRecipient.temporary) {
      locked.status = "pending";
      locked.lastError = refreshedRecipient.reason;
      locked.nextAttemptAt = new Date(
        Date.now() +
          getRecipientVerificationRetryDelayMs(
            locked.attempts,
            refreshedRecipient.retryAfterMs
          )
      );
      await locked.save();
      console.warn("Queued customer recipient verification deferred", {
        restaurantId:
          typeof locked.metadata?.restaurantId === "string"
            ? locked.metadata.restaurantId
            : locked.restaurantId
              ? String(locked.restaurantId)
              : undefined,
        orderId: locked.metadata?.orderId,
        kind: locked.metadata?.kind,
        queueMessageId: String(locked._id),
        reason: refreshedRecipient.reason
      });
      return true;
    }

    locked.status = "cancelled";
    locked.lastError = recoverableRecipientCancellationReasons.has(
      refreshedRecipient.reason ?? ""
    )
      ? refreshedRecipient.reason
      : "no_current_whatsapp_recipient";
    await locked.save();
    if (locked.metadata?.kind === "customer_campaign") {
      await cancelStaleCampaignRecipient(
        locked.metadata,
        refreshedRecipient.reason ?? "no_current_whatsapp_recipient"
      );
    }
    console.warn("Queued customer WhatsApp message cancelled", {
      restaurantId:
        typeof locked.metadata?.restaurantId === "string"
          ? locked.metadata.restaurantId
          : locked.restaurantId
            ? String(locked.restaurantId)
            : undefined,
      orderId: locked.metadata?.orderId,
      kind: locked.metadata?.kind,
      queueMessageId: String(locked._id),
      reason: refreshedRecipient.reason
    });
    return true;
  }

  if (locked.type === "image") {
    console.info("[customerAgent] image delivery attempted", {
      restaurantId: locked.restaurantId ? String(locked.restaurantId) : undefined,
      customerPhone: locked.to,
      menuItemId: locked.metadata?.menuItemId,
      menuItemName: locked.metadata?.menuItemName,
      attempt: locked.attempts
    });
  }

  const result = await (dependencies.sendMessage ?? sendQueuedWasenderMessage)(locked);
  if (!commerceMessage) {
    await updateOrderSideEffectAfterSend(locked, result);
    await applyOrderFeedbackProviderResult(locked, result);
  }

  if (result.success) {
    locked.status = "sent";
    locked.sentAt = new Date();
    locked.lastStatus = result.status;
    locked.providerData = result.data;
    locked.providerMessageId = extractWasenderProviderMessageId(result.data);
    locked.lastError = undefined;
    await locked.save();
    if (
      locked.metadata?.kind === commercePaidOrderReceiptNotificationKind &&
      locked.metadata.reviewInvitationEligible === true
    ) {
      try {
        const invitationJob = await ensureCommerceReviewInvitationJobForSentReceipt(
          String(locked._id)
        );
        if (!invitationJob) {
          console.warn("Commerce review invitation trigger failed", {
            businessId: locked.businessId ? String(locked.businessId) : undefined,
            commerceEventId: locked.metadata.commerceEventId,
            receiptQueueMessageId: String(locked._id),
            code: "REVIEW_INVITATION_JOB_NOT_CREATED"
          });
        }
      } catch {
        console.warn("Commerce review invitation trigger failed", {
          businessId: locked.businessId ? String(locked.businessId) : undefined,
          commerceEventId: locked.metadata.commerceEventId,
          receiptQueueMessageId: String(locked._id),
          code: "REVIEW_INVITATION_TRIGGER_FAILED"
        });
      }
    } else if (locked.metadata?.kind === commercePurchaseReviewInvitationKind) {
      await CommerceReviewInvitationJob.updateOne(
        {
          _id: locked.metadata.commerceReviewInvitationJobId,
          businessId: locked.businessId,
          invitationOutboundMessageId: locked._id,
          status: "enqueued"
        },
        {
          $set: { status: "sent", completedAt: locked.sentAt },
          $unset: { lastErrorCode: "" }
        }
      );
    }
    if (!commerceMessage) {
      await updateCampaignRecipientAfterAttempt(locked, result, false);
    }
    return true;
  }

  locked.lastError = getErrorMessage(result);
  locked.lastStatus = result.status;
  locked.providerData = result.data;

  if (locked.attempts >= locked.maxAttempts) {
    locked.status = "failed";
  } else {
    locked.status = "pending";
    locked.nextAttemptAt = new Date(Date.now() + getWasenderRetryDelayMs(result));
  }

  await locked.save();
  if (
    locked.status === "failed" &&
    locked.metadata?.kind === commercePurchaseReviewInvitationKind
  ) {
    await CommerceReviewInvitationJob.updateOne(
      {
        _id: locked.metadata.commerceReviewInvitationJobId,
        businessId: locked.businessId,
        invitationOutboundMessageId: locked._id,
        status: "enqueued"
      },
      {
        $set: {
          status: "failed",
          completedAt: new Date(),
          lastErrorCode: "REVIEW_INVITATION_SEND_FAILED"
        }
      }
    );
    console.warn("Commerce review invitation send failed", {
      businessId: locked.businessId ? String(locked.businessId) : undefined,
      commerceEventId: locked.metadata.commerceEventId,
      jobId: locked.metadata.commerceReviewInvitationJobId,
      code: "REVIEW_INVITATION_SEND_FAILED"
    });
  }
  if (!commerceMessage) {
    await updateCampaignRecipientAfterAttempt(
      locked,
      result,
      locked.status === "failed"
    );
  }

  if (locked.type === "image") {
    console.warn("[customerAgent] menu image delivery failed", {
      restaurantId: locked.restaurantId ? String(locked.restaurantId) : undefined,
      customerPhone: locked.to,
      menuItemId: locked.metadata?.menuItemId,
      menuItemName: locked.metadata?.menuItemName,
      status: result.status,
      error: redactUrls(getErrorMessage(result)),
      retryScheduled: locked.status === "pending"
    });

    if (locked.status === "failed" && locked.metadata?.kind === "menu_item_image_delivery") {
      const queueMessageId = String(locked._id);
      await (dependencies.enqueueMessage ?? enqueueWasenderMessage)({
        restaurantId: locked.restaurantId ? String(locked.restaurantId) : undefined,
        sessionId: locked.sessionId,
        to: locked.to,
        type: "text",
        text: "I couldn't send the image right now. Please try again.",
        apiKey: locked.apiKey,
        idempotencyKey: `${locked.idempotencyKey ?? queueMessageId}:safe-image-fallback`,
        metadata: {
          ...locked.metadata,
          kind: "menu_item_image_failure",
          failedImageQueueMessageId: queueMessageId,
          responsePurpose: "menu_item_image_failure"
        }
      });
    }
  }
  return true;
};

export const drainQueuedWasenderMessages = async (
  maxMessages = 25
): Promise<number> => {
  let processed = 0;

  for (let index = 0; index < maxMessages; index += 1) {
    const didProcess = await processNextQueuedWasenderMessage();

    if (!didProcess) {
      break;
    }

    processed += 1;

    if (getSessionSpacingMs() > 0) {
      await sleep(10);
    }
  }

  return processed;
};

export const recoverStaleSendingWasenderMessages = async (
  now = new Date()
): Promise<number> => {
  const cutoff = new Date(now.getTime() - staleSendingRecoveryMs);
  const result = await OutboundMessage.updateMany(
    {
      status: "sending",
      lastAttemptAt: { $lte: cutoff }
    },
    {
      $set: {
        status: "pending",
        nextAttemptAt: now,
        lastError: "Recovered after an interrupted queue worker attempt"
      }
    }
  );

  return result.modifiedCount;
};

export const startWasenderQueueWorker = (): void => {
  if (workerStarted) {
    return;
  }

  workerStarted = true;
  markRuntimeStarted("wasender_queue", workerIntervalMs);
  console.log(
    `[wasenderQueue] Worker started (check every ${workerIntervalMs / 1000}s)`
  );

  void recoverStaleSendingWasenderMessages().catch((error) => {
    console.error("Wasender queue recovery failed", {
      error:
        error instanceof Error
          ? error.message
          : "Unknown queue recovery error"
    });
  });

  const timer = setInterval(() => {
    if (workerBusy) {
      return;
    }

    workerBusy = true;
    markRuntimeRunStarted("wasender_queue");
    void processNextQueuedWasenderMessage()
      .then(() => {
        markRuntimeRunSucceeded("wasender_queue");
      })
      .catch((error) => {
        markRuntimeRunFailed("wasender_queue", "QUEUE_PASS_FAILED");
        console.error("Wasender queue worker failed", {
          error: error instanceof Error ? error.message : "Unknown queue worker error"
        });
      })
      .finally(() => {
        workerBusy = false;
      });
  }, workerIntervalMs);

  timer.unref?.();
};
