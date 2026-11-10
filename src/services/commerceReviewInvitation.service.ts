import { randomUUID } from "crypto";
import { Types } from "mongoose";
import { Business } from "../models/business.model";
import { CommercePaidOrderEvent } from "../models/commercePaidOrderEvent.model";
import {
  CommerceReviewInvitationJob,
  type ICommerceReviewInvitationJobDocument
} from "../models/commerceReviewInvitationJob.model";
import { OutboundMessage } from "../models/outboundMessage.model";
import { normalizeGhanaPhone } from "../utils/phone.util";
import {
  CommerceIntegrationError,
  getCommerceReviewLinks
} from "./commerceIntegration.service";
import {
  commercePaidOrderReceiptNotificationKind,
  commercePurchaseReviewInvitationKind,
  getCommerceNotificationConfigurationReason
} from "./commerceNotificationConfiguration.service";
import { ensureCommerceReviewInvitationJobForSentReceipt } from "./commerceReviewInvitationJob.service";
import {
  markRuntimeRunFailed,
  markRuntimeRunStarted,
  markRuntimeRunSucceeded,
  markRuntimeStarted
} from "./runtimeHealth.service";
import { enqueueWasenderMessage } from "./wasenderQueue.service";

const workerIntervalMs = 3_000;
const leaseMs = 5 * 60_000;
const reconciliationIntervalMs = 60_000;
const initialRetryMs = 30_000;
const maximumRetryMs = 15 * 60_000;
let workerStarted = false;
let workerBusy = false;
let lastReconciliationAt = 0;

const logFailureCode = (
  job: ICommerceReviewInvitationJobDocument,
  businessId: string,
  code: string
): void => {
  console.warn("Commerce review invitation failed", {
    businessId,
    commerceEventId: job.commerceEventId,
    jobId: String(job._id),
    code
  });
};

const getRetryDelayMs = (attempts: number): number => {
  const exponent = Math.min(Math.max(attempts - 1, 0), 8);
  return Math.min(initialRetryMs * 2 ** exponent, maximumRetryMs);
};

const buildQueueIdempotencyKey = (
  businessId: string,
  externalOrderId: string,
  customerRecipient: string
): string =>
  `commerce:${businessId}:order:${externalOrderId}:customer:${customerRecipient}:review-invitation`;

const formatInvitation = (
  orderNumber: string,
  products: Array<{ name: string; reviewUrl: string }>
): string => {
  const productLines = products
    .map((product) => `• ${product.name}\n${product.reviewUrl}`)
    .join("\n\n");

  return [
    `Review your purchases from order ${orderNumber}:`,
    productLines,
    "After you receive and use the products, please leave an honest review. You may discuss the product, our service, or both."
  ].join("\n\n");
};

const reconcileNextSentReceipt = async (): Promise<void> => {
  const receiptMessage = await OutboundMessage.findOne({
    status: "sent",
    "metadata.kind": commercePaidOrderReceiptNotificationKind,
    "metadata.reviewInvitationEligible": true,
    "metadata.reviewInvitationJobCreatedAt": { $exists: false }
  })
    .sort({ sentAt: 1, _id: 1 })
    .select("_id businessId metadata");
  if (!receiptMessage) return;

  await ensureCommerceReviewInvitationJobForSentReceipt(String(receiptMessage._id));
};

const reconcileNextInvitationOutcome = async (): Promise<void> => {
  const message = await OutboundMessage.findOne({
    status: { $in: ["sent", "failed", "cancelled"] },
    "metadata.kind": commercePurchaseReviewInvitationKind,
    "metadata.reviewInvitationOutcomeRecordedAt": { $exists: false }
  })
    .sort({ updatedAt: 1, _id: 1 })
    .select("businessId status sentAt metadata");
  if (!message) return;

  const jobId =
    typeof message.metadata?.commerceReviewInvitationJobId === "string"
      ? message.metadata.commerceReviewInvitationJobId
      : "";
  if (!jobId || !Types.ObjectId.isValid(jobId)) {
    await OutboundMessage.updateOne(
      { _id: message._id },
      { $set: { "metadata.reviewInvitationOutcomeRecordedAt": new Date() } }
    );
    return;
  }

  if (message.status === "sent") {
    await CommerceReviewInvitationJob.updateOne(
      {
        _id: jobId,
        businessId: message.businessId,
        invitationOutboundMessageId: message._id,
        status: "enqueued"
      },
      {
        $set: { status: "sent", completedAt: message.sentAt ?? new Date() },
        $unset: { lastErrorCode: "" }
      }
    );
  } else if (message.status === "failed" || message.status === "cancelled") {
    const job = await CommerceReviewInvitationJob.findOneAndUpdate(
      {
        _id: jobId,
        businessId: message.businessId,
        invitationOutboundMessageId: message._id,
        status: "enqueued"
      },
      {
        $set: {
          status: "failed",
          completedAt: new Date(),
          lastErrorCode: "REVIEW_INVITATION_QUEUE_TERMINAL"
        }
      },
      { new: true }
    );
    if (job) {
      logFailureCode(
        job,
        String(job.businessId),
        "REVIEW_INVITATION_QUEUE_TERMINAL"
      );
    }
  }

  await OutboundMessage.updateOne(
    { _id: message._id },
    { $set: { "metadata.reviewInvitationOutcomeRecordedAt": new Date() } }
  );
};

const claimNextJob = async (
  now = new Date()
): Promise<{ job: ICommerceReviewInvitationJobDocument; claimId: string } | null> => {
  const claimId = randomUUID();
  const job = await CommerceReviewInvitationJob.findOneAndUpdate(
    {
      status: { $in: ["pending", "processing"] },
      nextAttemptAt: { $lte: now },
      $or: [
        { leaseExpiresAt: { $lte: now } },
        { leaseExpiresAt: { $exists: false } }
      ]
    },
    {
      $set: {
        status: "processing",
        claimId,
        leaseExpiresAt: new Date(now.getTime() + leaseMs)
      }
    },
    { new: true, sort: { nextAttemptAt: 1, createdAt: 1 } }
  );

  return job ? { job, claimId } : null;
};

const findExistingInvitationMessage = async (
  job: ICommerceReviewInvitationJobDocument,
  businessId: string
) =>
  OutboundMessage.findOne({
    businessId,
    idempotencyKey: buildQueueIdempotencyKey(
      businessId,
      job.externalOrderId,
      job.customerRecipient
    )
  });

const existingInvitationMessageMatchesScope = (
  job: ICommerceReviewInvitationJobDocument,
  businessId: string,
  message: NonNullable<
    Awaited<ReturnType<typeof findExistingInvitationMessage>>
  >
): boolean =>
  message.to === job.customerRecipient &&
  message.metadata?.kind === commercePurchaseReviewInvitationKind &&
  message.metadata.businessId === businessId &&
  message.metadata.commerceEventId === job.commerceEventId &&
  message.metadata.recipientType === "customer";

const reconnectExistingInvitationMessage = async (
  job: ICommerceReviewInvitationJobDocument,
  claimId: string,
  businessId: string,
  message: Awaited<ReturnType<typeof findExistingInvitationMessage>>
): Promise<void> => {
  if (!message) return;

  const terminalFailure = message.status === "failed" || message.status === "cancelled";
  const nextStatus = message.status === "sent"
    ? "sent"
    : terminalFailure
      ? "failed"
      : "enqueued";
  const now = new Date();

  const jobUpdate = await CommerceReviewInvitationJob.updateOne(
    {
      _id: job._id,
      businessId,
      status: "processing",
      claimId
    },
    {
      $set: {
        status: nextStatus,
        invitationOutboundMessageId: message._id,
        completedAt: now,
        ...(terminalFailure
          ? { lastErrorCode: "REVIEW_INVITATION_QUEUE_TERMINAL" }
          : {})
      },
      $unset: {
        claimId: "",
        leaseExpiresAt: "",
        ...(!terminalFailure ? { lastErrorCode: "" } : {})
      }
    }
  );
  if (jobUpdate.modifiedCount === 0) return;

  await OutboundMessage.updateOne(
    {
      _id: message._id,
      businessId,
      idempotencyKey: message.idempotencyKey
    },
    {
      $set: {
        "metadata.commerceReviewInvitationJobId": String(job._id)
      }
    }
  );
  if (terminalFailure) {
    logFailureCode(job, businessId, "REVIEW_INVITATION_QUEUE_TERMINAL");
  }
};

const finishJob = async (
  job: ICommerceReviewInvitationJobDocument,
  claimId: string,
  status: "enqueued" | "skipped" | "failed",
  values: Record<string, unknown> = {}
): Promise<void> => {
  const setsLastError = typeof values.lastErrorCode === "string";
  await CommerceReviewInvitationJob.updateOne(
    { _id: job._id, status: "processing", claimId },
    {
      $set: {
        status,
        completedAt: new Date(),
        ...values
      },
      $unset: {
        claimId: "",
        leaseExpiresAt: "",
        ...(setsLastError ? {} : { lastErrorCode: "" })
      }
    }
  );
};

const deferJob = async (
  job: ICommerceReviewInvitationJobDocument,
  claimId: string,
  errorCode: string
): Promise<void> => {
  const exhausted = job.attempts >= job.maxAttempts;
  await CommerceReviewInvitationJob.updateOne(
    { _id: job._id, status: "processing", claimId },
    {
      $set: {
        status: exhausted ? "failed" : "pending",
        nextAttemptAt: new Date(Date.now() + getRetryDelayMs(job.attempts)),
        lastErrorCode: errorCode,
        ...(exhausted ? { completedAt: new Date() } : {})
      },
      $unset: { claimId: "", leaseExpiresAt: "" }
    }
  );
};

const deferPausedJob = async (
  job: ICommerceReviewInvitationJobDocument,
  claimId: string,
  reason: string
): Promise<void> => {
  await CommerceReviewInvitationJob.updateOne(
    { _id: job._id, status: "processing", claimId },
    {
      $set: {
        status: "pending",
        nextAttemptAt: new Date(Date.now() + initialRetryMs),
        lastErrorCode: reason
      },
      $unset: { claimId: "", leaseExpiresAt: "", completedAt: "" }
    }
  );
};

const beginProcessingAttempt = async (
  job: ICommerceReviewInvitationJobDocument,
  claimId: string
): Promise<ICommerceReviewInvitationJobDocument | null> =>
  CommerceReviewInvitationJob.findOneAndUpdate(
    {
      _id: job._id,
      status: "processing",
      claimId,
      $expr: { $lt: ["$attempts", "$maxAttempts"] }
    },
    {
      $inc: { attempts: 1 },
      $set: { lastAttemptAt: new Date() }
    },
    { new: true }
  );

export const processNextCommerceReviewInvitation = async (): Promise<boolean> => {
  if (Date.now() - lastReconciliationAt >= reconciliationIntervalMs) {
    lastReconciliationAt = Date.now();
    try {
      await reconcileNextSentReceipt();
      await reconcileNextInvitationOutcome();
    } catch {
      console.warn("Commerce review invitation reconciliation failed", {
        code: "REVIEW_INVITATION_RECONCILIATION_FAILED"
      });
    }
  }

  const claimed = await claimNextJob();
  if (!claimed) return false;
  const { job, claimId } = claimed;
  const businessId = String(job.businessId);

  try {
    const existingInvitationMessage = await findExistingInvitationMessage(
      job,
      businessId
    );
    if (existingInvitationMessage) {
      if (
        !existingInvitationMessageMatchesScope(
          job,
          businessId,
          existingInvitationMessage
        )
      ) {
        await finishJob(job, claimId, "failed", {
          lastErrorCode: "REVIEW_INVITATION_QUEUE_SCOPE_MISMATCH"
        });
        logFailureCode(
          job,
          businessId,
          "REVIEW_INVITATION_QUEUE_SCOPE_MISMATCH"
        );
        return true;
      }
      await reconnectExistingInvitationMessage(
        job,
        claimId,
        businessId,
        existingInvitationMessage
      );
      return true;
    }

    if (job.attempts >= job.maxAttempts) {
      await finishJob(job, claimId, "failed", {
        lastErrorCode: "REVIEW_INVITATION_ATTEMPTS_EXHAUSTED"
      });
      logFailureCode(job, businessId, "REVIEW_INVITATION_ATTEMPTS_EXHAUSTED");
      return true;
    }

    const receiptMessage = await OutboundMessage.findOne({
      _id: job.receiptOutboundMessageId,
      businessId,
      status: "sent",
      "metadata.kind": commercePaidOrderReceiptNotificationKind,
      "metadata.reviewInvitationEligible": true
    }).select("_id");
    if (!receiptMessage) {
      await finishJob(job, claimId, "failed", {
        lastErrorCode: "RECEIPT_MESSAGE_NOT_SENT"
      });
      logFailureCode(job, businessId, "RECEIPT_MESSAGE_NOT_SENT");
      return true;
    }

    const event = await CommercePaidOrderEvent.findOne({
      businessId,
      eventId: job.commerceEventId,
      "order.externalOrderId": job.externalOrderId,
      status: "enqueued"
    });
    if (!event) {
      await finishJob(job, claimId, "failed", {
        lastErrorCode: "COMMERCE_EVENT_MISSING"
      });
      logFailureCode(job, businessId, "COMMERCE_EVENT_MISSING");
      return true;
    }

    const currentRecipient = normalizeGhanaPhone(event.order.customer.phone);
    if (!event.order.customer.whatsappConsent || currentRecipient !== job.customerRecipient) {
      await finishJob(job, claimId, "skipped", {
        lastErrorCode: "CUSTOMER_NOTIFICATION_INELIGIBLE"
      });
      return true;
    }

    const business = await Business.findById(businessId).select(
      "+commerceIntegration.apiKey +whatsappIntegration.wasenderApiToken"
    );
    if (!business) {
      await finishJob(job, claimId, "failed", { lastErrorCode: "BUSINESS_MISSING" });
      logFailureCode(job, businessId, "BUSINESS_MISSING");
      return true;
    }

    const configurationReason = getCommerceNotificationConfigurationReason(business);
    if (configurationReason) {
      const errorCode = configurationReason.toUpperCase();
      await deferPausedJob(job, claimId, errorCode);
      return true;
    }

    const attemptedJob = await beginProcessingAttempt(job, claimId);
    if (!attemptedJob) {
      await finishJob(job, claimId, "failed", {
        lastErrorCode: "REVIEW_INVITATION_ATTEMPTS_EXHAUSTED"
      });
      logFailureCode(job, businessId, "REVIEW_INVITATION_ATTEMPTS_EXHAUSTED");
      return true;
    }

    const response = await getCommerceReviewLinks(
      business,
      event.order.externalOrderId,
      event.order.orderNumber,
      event.order.items.map((item) => ({
        productId: item.externalProductId,
        name: item.name
      }))
    );
    const itemNames = new Map(
      event.order.items.map((item) => [item.externalProductId, item.name])
    );
    const products = response.products.flatMap((product) => {
      const name = itemNames.get(product.productId);
      if (
        !name ||
        product.reviewState.toLowerCase() === "submitted" ||
        !product.reviewUrl
      ) {
        return [];
      }
      return [{ name, reviewUrl: product.reviewUrl }];
    });

    if (products.length === 0) {
      await finishJob(attemptedJob, claimId, "skipped");
      return true;
    }

    const integration = business.whatsappIntegration!;
    const invitationMessage = await enqueueWasenderMessage({
      businessId,
      sessionId: integration.wasenderSessionId!,
      to: currentRecipient,
      type: "text",
      text: formatInvitation(event.order.orderNumber, products),
      apiKey: integration.wasenderApiToken!,
      idempotencyKey: buildQueueIdempotencyKey(
        businessId,
        event.order.externalOrderId,
        currentRecipient
      ),
      metadata: {
        kind: commercePurchaseReviewInvitationKind,
        businessId,
        commerceEventId: event.eventId,
        commerceReviewInvitationJobId: String(attemptedJob._id),
        recipientType: "customer"
      }
    });

    await finishJob(attemptedJob, claimId, "enqueued", {
      invitationOutboundMessageId: invitationMessage._id
    });
    return true;
  } catch (error) {
    const errorCode =
      error instanceof CommerceIntegrationError
        ? error.code
        : "REVIEW_INVITATION_PROCESSING_FAILED";
    const existingInvitationMessage = await findExistingInvitationMessage(
      job,
      businessId
    );
    if (existingInvitationMessage) {
      if (
        existingInvitationMessageMatchesScope(
          job,
          businessId,
          existingInvitationMessage
        )
      ) {
        await reconnectExistingInvitationMessage(
          job,
          claimId,
          businessId,
          existingInvitationMessage
        );
      } else {
        await finishJob(job, claimId, "failed", {
          lastErrorCode: "REVIEW_INVITATION_QUEUE_SCOPE_MISMATCH"
        });
        logFailureCode(
          job,
          businessId,
          "REVIEW_INVITATION_QUEUE_SCOPE_MISMATCH"
        );
      }
      return true;
    }
    let currentJob: ICommerceReviewInvitationJobDocument | null =
      await CommerceReviewInvitationJob.findOne({
        _id: job._id,
        status: "processing",
        claimId
      });
    if (currentJob && currentJob.attempts === job.attempts) {
      currentJob = await beginProcessingAttempt(currentJob, claimId);
    }
    if (currentJob) {
      await deferJob(currentJob, claimId, errorCode);
      logFailureCode(currentJob, businessId, errorCode);
    } else {
      await finishJob(job, claimId, "failed", {
        lastErrorCode: "REVIEW_INVITATION_ATTEMPTS_EXHAUSTED"
      });
    }
    return true;
  }
};

export const startCommerceReviewInvitationWorker = (): void => {
  if (workerStarted) return;
  workerStarted = true;
  markRuntimeStarted("commerce_review_invitation", workerIntervalMs);
  console.log(
    `[commerceReviewInvitation] Worker started (check every ${workerIntervalMs / 1000}s)`
  );

  const timer = setInterval(() => {
    if (workerBusy) return;
    workerBusy = true;
    markRuntimeRunStarted("commerce_review_invitation");
    void processNextCommerceReviewInvitation()
      .then(() => markRuntimeRunSucceeded("commerce_review_invitation"))
      .catch(() => {
        markRuntimeRunFailed(
          "commerce_review_invitation",
          "COMMERCE_REVIEW_INVITATION_PASS_FAILED"
        );
        console.error("Commerce review invitation worker failed", {
          code: "COMMERCE_REVIEW_INVITATION_PASS_FAILED"
        });
      })
      .finally(() => {
        workerBusy = false;
      });
  }, workerIntervalMs);
  timer.unref();
};
