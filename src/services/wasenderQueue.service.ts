import { Order } from "../models/order.model";
import { CustomerSession, type ICustomerSessionDocument } from "../models/customerSession.model";
import {
  OutboundMessage,
  type IOutboundMessageDocument,
  type OutboundMessageType
} from "../models/outboundMessage.model";
import {
  extractWasenderProviderMessageId,
  sendDocumentMessage,
  sendTextMessage,
  type WasenderSendResult
} from "./wasender.service";

export interface EnqueueWasenderMessageInput {
  restaurantId?: string;
  sessionId: string;
  to: string;
  type: OutboundMessageType;
  text?: string;
  documentUrl?: string;
  caption?: string;
  apiKey?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

const defaultSpacingMs = 5_000;
const workerIntervalMs = 1_000;
const defaultMaxAttempts = 5;
let workerStarted = false;
let workerBusy = false;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const getErrorMessage = (result: WasenderSendResult): string =>
  result.error || (result.status ? `Wasender status ${result.status}` : "Wasender send failed");

const transactionalKinds = new Set([
  "owner_order_notification",
  "customer_order_confirmed_notification",
  "customer_order_rejected_notification",
  "receipt_delivery"
]);

export const isTransactionalQueuedMessage = (metadata?: Record<string, unknown>): boolean => {
  const kind = typeof metadata?.kind === "string" ? metadata.kind : undefined;

  return Boolean(kind && transactionalKinds.has(kind));
};

export const isQueuedConversationalMessageStale = (
  metadata: Record<string, unknown> | undefined,
  session: Pick<ICustomerSessionDocument, "conversationVersion" | "currentStep"> | null
): boolean => {
  if (!metadata || isTransactionalQueuedMessage(metadata)) {
    return false;
  }

  if (metadata.purpose === "transactional") {
    return false;
  }

  if (!session) {
    return false;
  }

  const expectedVersion = Number(metadata.conversationVersion);
  const expectedStep = typeof metadata.expectedDraftStep === "string" ? metadata.expectedDraftStep : undefined;

  if (Number.isFinite(expectedVersion) && session.conversationVersion > expectedVersion) {
    return true;
  }

  if (expectedStep && session.currentStep !== expectedStep) {
    const purpose = typeof metadata.responsePurpose === "string" ? metadata.responsePurpose : "";

    if (purpose === "greeting" && session.currentStep !== "idle") {
      return true;
    }
  }

  return false;
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

const updateOrderSideEffectAfterSend = async (
  message: IOutboundMessageDocument,
  result: WasenderSendResult
): Promise<void> => {
  const orderId = message.metadata?.orderId;
  const kind = message.metadata?.kind;

  if (typeof orderId !== "string" || typeof kind !== "string") {
    return;
  }

  const now = new Date();
  const failureReason = result.success ? undefined : getErrorMessage(result);

  if (kind === "owner_order_notification") {
    const providerMessageId = result.success ? extractWasenderProviderMessageId(result.data) : undefined;
    await Order.updateOne(
      { _id: orderId },
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

  if (kind === "customer_order_confirmed_notification") {
    await Order.updateOne(
      { _id: orderId },
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
    return;
  }

  if (kind === "customer_order_rejected_notification") {
    await Order.updateOne(
      { _id: orderId },
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
      { _id: orderId },
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
  }
};

export const enqueueWasenderMessage = async (
  input: EnqueueWasenderMessageInput
): Promise<IOutboundMessageDocument> => {
  if (input.idempotencyKey) {
    const existing = await OutboundMessage.findOne({
      idempotencyKey: input.idempotencyKey
    }).select("+apiKey");

    if (existing) {
      return existing;
    }
  }

  try {
    return await OutboundMessage.create({
      restaurantId: input.restaurantId,
      sessionId: input.sessionId,
      to: input.to,
      type: input.type,
      text: input.text,
      documentUrl: input.documentUrl,
      caption: input.caption,
      apiKey: input.apiKey,
      status: "pending",
      attempts: 0,
      maxAttempts: defaultMaxAttempts,
      nextAttemptAt: new Date(),
      idempotencyKey: input.idempotencyKey,
      metadata: input.metadata
    });
  } catch (error) {
    if (
      input.idempotencyKey &&
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: number }).code === 11000
    ) {
      const existing = await OutboundMessage.findOne({
        idempotencyKey: input.idempotencyKey
      }).select("+apiKey");

      if (existing) {
        return existing;
      }
    }

    throw error;
  }
};

const sendQueuedMessage = async (
  message: IOutboundMessageDocument
): Promise<WasenderSendResult> => {
  if (message.type === "document") {
    if (!message.documentUrl) {
      return {
        success: false,
        error: "Queued document message is missing documentUrl"
      };
    }

    return sendDocumentMessage(
      message.sessionId,
      message.to,
      message.documentUrl,
      message.caption,
      { apiKey: message.apiKey }
    );
  }

  return sendTextMessage(message.sessionId, message.to, message.text ?? "", {
    apiKey: message.apiKey
  });
};

export const processNextQueuedWasenderMessage = async (): Promise<boolean> => {
  const now = new Date();
  const candidate = await OutboundMessage.findOne({
    status: "pending",
    nextAttemptAt: { $lte: now }
  })
    .sort({ nextAttemptAt: 1, createdAt: 1 })
    .select("+apiKey");

  if (!candidate) {
    return false;
  }

  const spacingMs = getSessionSpacingMs();
  const lastSent = await OutboundMessage.findOne({
    sessionId: candidate.sessionId,
    status: "sent",
    sentAt: { $exists: true }
  })
    .sort({ sentAt: -1 })
    .select("sentAt");

  const nextSessionSendAt = getNextSessionSendAt(lastSent?.sentAt, new Date(), spacingMs);

  if (nextSessionSendAt) {
    candidate.nextAttemptAt = nextSessionSendAt;
    await candidate.save();
    return true;
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
  ).select("+apiKey");

  if (!locked) {
    return true;
  }

  if (!isTransactionalQueuedMessage(locked.metadata)) {
    const restaurantId =
      typeof locked.metadata?.restaurantId === "string"
        ? locked.metadata.restaurantId
        : locked.restaurantId
          ? String(locked.restaurantId)
          : undefined;
    const customerPhone =
      typeof locked.metadata?.customerPhone === "string" ? locked.metadata.customerPhone : locked.to;
    const session =
      restaurantId && customerPhone
        ? await CustomerSession.findOne({ restaurantId, customerPhone }).select(
            "conversationVersion currentStep"
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

  const result = await sendQueuedMessage(locked);
  await updateOrderSideEffectAfterSend(locked, result);

  if (result.success) {
    locked.status = "sent";
    locked.sentAt = new Date();
    locked.lastStatus = result.status;
    locked.providerData = result.data;
    locked.lastError = undefined;
    await locked.save();
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

export const startWasenderQueueWorker = (): void => {
  if (workerStarted) {
    return;
  }

  workerStarted = true;

  const timer = setInterval(() => {
    if (workerBusy) {
      return;
    }

    workerBusy = true;
    void processNextQueuedWasenderMessage()
      .catch((error) => {
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
