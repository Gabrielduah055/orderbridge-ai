import { createHash, randomUUID } from "crypto";
import { Business } from "../models/business.model";
import {
  WebhookEvent,
  type IWebhookEventDocument
} from "../models/webhookEvent.model";
import { OutboundMessage } from "../models/outboundMessage.model";
import {
  normalizeIncomingWebhook,
  type NormalizedWasenderWebhook
} from "./wasender.service";
import {
  BusinessWasenderIdentityResolutionError,
  resolveBusinessWasenderIdentity
} from "./businessWasenderIdentity.service";
import { handleCommerceChatMessage } from "./websiteChat.service";
import { enqueueWasenderMessage } from "./wasenderQueue.service";
import {
  commerceWhatsappChatReplyKind,
  getCommerceWhatsappChatConfigurationReason
} from "./commerceNotificationConfiguration.service";
import {
  markRuntimeRunFailed,
  markRuntimeRunStarted,
  markRuntimeRunSucceeded,
  markRuntimeStarted
} from "./runtimeHealth.service";

const workerIntervalMs = 2_000;
const processingLeaseMs = 5 * 60_000;
const initialRetryMs = 30_000;
const maximumRetryMs = 15 * 60_000;
let workerStarted = false;
let workerBusy = false;

export const buildCommerceWebhookEventId = (
  businessId: string,
  sessionId: string,
  providerMessageId: string
): string =>
  `commerce:${createHash("sha256")
    .update(`${businessId}:${sessionId}:${providerMessageId}`, "utf8")
    .digest("hex")}`;

export const persistCommerceWhatsappWebhookEvent = async (
  businessId: string,
  sessionId: string,
  webhook: NormalizedWasenderWebhook
): Promise<IWebhookEventDocument> => {
  const providerMessageId = webhook.messageId ?? "";
  const eventId = buildCommerceWebhookEventId(
    businessId,
    sessionId,
    providerMessageId
  );
  try {
    const event = await WebhookEvent.findOneAndUpdate(
      { provider: "wasender", eventId },
      {
        $set: {
          eventKind: "commerce_chat",
          businessId,
          providerMessageId,
          sessionId
        },
        $setOnInsert: {
          provider: "wasender",
          eventId,
          from: webhook.from,
          payload: webhook.rawPayload,
          status: "received",
          processingAttempts: 0,
          nextProcessingAttemptAt: new Date()
        }
      },
      { upsert: true, new: true }
    );
    if (!event) throw new Error("Commerce webhook event was not persisted");
    return event;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: number }).code === 11000
    ) {
      const existing = await WebhookEvent.findOne({
        provider: "wasender",
        eventId
      });
      if (existing) return existing;
    }
    throw error;
  }
};

const getRetryDelayMs = (
  attempts: number,
  providerRetryAfterMs?: number
): number => {
  if (providerRetryAfterMs && providerRetryAfterMs > 0) {
    return Math.min(providerRetryAfterMs, maximumRetryMs);
  }
  const exponent = Math.min(Math.max(attempts - 1, 0), 8);
  return Math.min(initialRetryMs * 2 ** exponent, maximumRetryMs);
};

const deferClaimedEvent = async (
  event: IWebhookEventDocument,
  claimId: string,
  reason: string,
  retryAfterMs?: number
): Promise<void> => {
  await WebhookEvent.updateOne(
    {
      _id: event._id,
      eventKind: "commerce_chat",
      status: "processing",
      processingClaimId: claimId
    },
    {
      $set: {
        status: "failed",
        nextProcessingAttemptAt: new Date(
          Date.now() +
            getRetryDelayMs(event.processingAttempts ?? 0, retryAfterMs)
        ),
        failureReason: reason
      },
      $unset: {
        processingClaimId: "",
        processingLeaseExpiresAt: ""
      }
    }
  );
};

const claimNextEvent = async (
  now = new Date()
): Promise<{ event: IWebhookEventDocument; claimId: string } | null> => {
  const claimId = randomUUID();
  const event = await WebhookEvent.findOneAndUpdate(
    {
      eventKind: "commerce_chat",
      status: { $in: ["received", "failed", "processing"] },
      $and: [
        {
          $or: [
            { nextProcessingAttemptAt: { $lte: now } },
            { nextProcessingAttemptAt: { $exists: false } }
          ]
        },
        {
          $or: [
            { processingLeaseExpiresAt: { $lte: now } },
            { processingLeaseExpiresAt: { $exists: false } }
          ]
        }
      ]
    },
    {
      $set: {
        status: "processing",
        processingClaimId: claimId,
        processingLeaseExpiresAt: new Date(now.getTime() + processingLeaseMs),
        lastProcessingAttemptAt: now
      },
      $inc: { processingAttempts: 1 }
    },
    { new: true, sort: { nextProcessingAttemptAt: 1, createdAt: 1 } }
  );
  return event ? { event, claimId } : null;
};

const markClaimedEventProcessed = async (
  event: IWebhookEventDocument,
  claimId: string
): Promise<void> => {
  await WebhookEvent.updateOne(
    {
      _id: event._id,
      eventKind: "commerce_chat",
      status: "processing",
      processingClaimId: claimId
    },
    {
      $set: {
        status: "processed",
        processedAt: new Date(),
        enqueueCompletedAt: new Date()
      },
      $unset: {
        processingClaimId: "",
        processingLeaseExpiresAt: "",
        failureReason: "",
        failureDetails: ""
      }
    }
  );
};

export const processNextCommerceWhatsappWebhook = async (): Promise<boolean> => {
  const claimed = await claimNextEvent();
  if (!claimed) return false;

  const { event, claimId } = claimed;
  const businessId = event.businessId ? String(event.businessId) : "";
  try {
    if (!businessId || !event.sessionId || !event.providerMessageId) {
      await deferClaimedEvent(event, claimId, "commerce_webhook_scope_invalid");
      return true;
    }

    const replyIdempotencyKey = `${event.eventId}:reply`;
    const existingReply = await OutboundMessage.exists({
      businessId,
      idempotencyKey: replyIdempotencyKey
    });
    if (existingReply) {
      await markClaimedEventProcessed(event, claimId);
      return true;
    }

    const business = await Business.findById(businessId).select(
      "+whatsappIntegration.wasenderApiToken +commerceIntegration.apiKey"
    );
    if (!business) {
      await deferClaimedEvent(event, claimId, "business_missing");
      return true;
    }
    const configurationReason = getCommerceWhatsappChatConfigurationReason(business);
    if (configurationReason) {
      await deferClaimedEvent(event, claimId, configurationReason);
      return true;
    }
    if (business.whatsappIntegration!.wasenderSessionId !== event.sessionId) {
      await deferClaimedEvent(event, claimId, "business_session_changed");
      return true;
    }

    let generatedReply = event.generatedReply;
    let customerKey = event.customerKey;
    let recipientAddress = event.recipientAddress;
    let conversationId = event.conversationId;

    if (!generatedReply || !customerKey || !recipientAddress || !conversationId) {
      const webhook = normalizeIncomingWebhook(event.payload);
      const identity = await resolveBusinessWasenderIdentity(
        businessId,
        event.sessionId,
        webhook,
        business.whatsappIntegration!.wasenderApiToken!
      );
      customerKey = identity.customerKey;
      recipientAddress = identity.recipientAddress;
      conversationId = `whatsapp:${customerKey}`;
      const result = await handleCommerceChatMessage({
        business,
        channel: "whatsapp",
        conversationId,
        message: webhook.message,
        sender: {
          identityKey: customerKey,
          customerKey,
          phone: identity.phone ?? "",
          normalizedAddress: recipientAddress,
          normalizedPhone: identity.phone ?? "",
          recipientAddress,
          role: "customer",
          verified: Boolean(identity.phone)
        },
        source: "whatsapp_chat",
        requestId: event.providerMessageId,
        metadata: {
          provider: "wasender",
          providerMessageId: event.providerMessageId,
          sessionId: event.sessionId,
          customerKey
        }
      });
      generatedReply = result.message;

      const persisted = await WebhookEvent.findOneAndUpdate(
        {
          _id: event._id,
          eventKind: "commerce_chat",
          status: "processing",
          processingClaimId: claimId
        },
        {
          $set: {
            generatedReply,
            customerKey,
            recipientAddress,
            conversationId,
            replyGeneratedAt: new Date()
          }
        },
        { new: true }
      );
      if (!persisted) return true;
    }

    await enqueueWasenderMessage({
      businessId,
      sessionId: event.sessionId,
      to: recipientAddress,
      type: "text",
      text: generatedReply,
      apiKey: business.whatsappIntegration!.wasenderApiToken!,
      idempotencyKey: replyIdempotencyKey,
      metadata: {
        kind: commerceWhatsappChatReplyKind,
        businessId,
        providerMessageId: event.providerMessageId,
        recipientAddress,
        customerKey,
        identitySessionId: event.sessionId,
        conversationId,
        recipientType: "webhook_sender"
      }
    });

    await markClaimedEventProcessed(event, claimId);
    return true;
  } catch (error) {
    const identityError = error instanceof BusinessWasenderIdentityResolutionError
      ? error
      : undefined;
    await deferClaimedEvent(
      event,
      claimId,
      identityError?.reason ?? "commerce_webhook_processing_failed",
      identityError?.retryAfterMs
    );
    console.error("Commerce Wasender webhook processing failed", {
      businessId: businessId || undefined,
      eventId: event.eventId,
      reason: identityError?.reason ?? "commerce_webhook_processing_failed"
    });
    return true;
  }
};

export const startCommerceWhatsappWebhookWorker = (): void => {
  if (workerStarted) return;
  workerStarted = true;
  markRuntimeStarted("commerce_whatsapp_webhooks", workerIntervalMs);

  const timer = setInterval(() => {
    if (workerBusy) return;
    workerBusy = true;
    markRuntimeRunStarted("commerce_whatsapp_webhooks");
    void processNextCommerceWhatsappWebhook()
      .then(() => markRuntimeRunSucceeded("commerce_whatsapp_webhooks"))
      .catch((error) => {
        markRuntimeRunFailed(
          "commerce_whatsapp_webhooks",
          "COMMERCE_WHATSAPP_WEBHOOK_PASS_FAILED"
        );
        console.error("Commerce WhatsApp webhook worker failed", {
          error: error instanceof Error ? error.message : "Unknown worker error"
        });
      })
      .finally(() => {
        workerBusy = false;
      });
  }, workerIntervalMs);
  timer.unref();
};
