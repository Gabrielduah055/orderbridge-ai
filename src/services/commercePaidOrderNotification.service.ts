import { randomUUID } from "crypto";
import { Business } from "../models/business.model";
import {
  CommercePaidOrderEvent,
  type ICommercePaidOrderEventDocument
} from "../models/commercePaidOrderEvent.model";
import { normalizeGhanaPhone } from "../utils/phone.util";
import {
  commercePaidOrderCustomerNotificationKind,
  commercePaidOrderStaffNotificationKind,
  getCommerceNotificationConfigurationReason,
  getNormalizedCommerceStaffRecipients
} from "./commerceNotificationConfiguration.service";
import {
  markRuntimeRunFailed,
  markRuntimeRunStarted,
  markRuntimeRunSucceeded,
  markRuntimeStarted
} from "./runtimeHealth.service";
import { enqueueWasenderMessage } from "./wasenderQueue.service";

const workerIntervalMs = 2_000;
const processingLeaseMs = 5 * 60_000;
const initialDeferralMs = 30_000;
const maximumDeferralMs = 15 * 60_000;
let workerStarted = false;
let workerBusy = false;

const formatMoney = (pesewas: number, currency: string): string =>
  `${currency} ${(pesewas / 100).toFixed(2)}`;

const buildCustomerPaymentConfirmation = (
  businessName: string,
  event: ICommercePaidOrderEventDocument
): string =>
  [
    `Payment received by ${businessName} for order ${event.order.orderNumber}.`,
    `Product amount paid: ${formatMoney(
      event.order.productPaymentTotalPesewas,
      event.order.currency
    )}.`,
    "The owner will contact you to arrange the delivery fee separately."
  ].join("\n");

const buildStaffPaidOrderNotification = (
  businessName: string,
  event: ICommercePaidOrderEventDocument
): string => {
  const itemLines = event.order.items.map(
    (item) =>
      `- ${item.quantity} × ${item.name} (${formatMoney(
        item.lineTotalPesewas,
        event.order.currency
      )})`
  );
  const customerLines = [
    `Customer: ${event.order.customer.name}`,
    `Customer phone: ${event.order.customer.phone}`,
    ...(event.order.customer.email
      ? [`Customer email: ${event.order.customer.email}`]
      : [])
  ];
  const delivery = event.order.delivery;
  const deliveryAddress = [
    delivery.addressLine1,
    delivery.addressLine2,
    delivery.city,
    delivery.region
  ]
    .filter(Boolean)
    .join(", ");
  const deliveryLines = [
    delivery.recipientName
      ? `Delivery recipient: ${delivery.recipientName}`
      : undefined,
    delivery.recipientPhone
      ? `Delivery phone: ${delivery.recipientPhone}`
      : undefined,
    deliveryAddress ? `Delivery address: ${deliveryAddress}` : undefined,
    delivery.postalCode ? `Postal code: ${delivery.postalCode}` : undefined,
    delivery.countryCode ? `Country: ${delivery.countryCode}` : undefined,
    delivery.instructions
      ? `Delivery instructions: ${delivery.instructions}`
      : undefined
  ].filter((line): line is string => Boolean(line));

  return [
    `Paid order received for ${businessName}`,
    `Order: ${event.order.orderNumber}`,
    "Items:",
    ...itemLines,
    `Product total paid: ${formatMoney(
      event.order.productPaymentTotalPesewas,
      event.order.currency
    )}`,
    ...customerLines,
    ...(deliveryLines.length > 0
      ? ["Delivery details:", ...deliveryLines]
      : ["Delivery details: Not provided"]),
    "Delivery fee: To be arranged separately with the customer."
  ].join("\n");
};

const getProcessingDeferralMs = (attempts: number): number => {
  const exponent = Math.min(Math.max(attempts - 1, 0), 8);
  return Math.min(initialDeferralMs * 2 ** exponent, maximumDeferralMs);
};

const deferClaimedEvent = async (
  event: ICommercePaidOrderEventDocument,
  claimId: string,
  reason: string,
  now = new Date()
): Promise<void> => {
  await CommercePaidOrderEvent.updateOne(
    {
      _id: event._id,
      status: "processing",
      processingClaimId: claimId
    },
    {
      $set: {
        status: "received",
        nextProcessingAttemptAt: new Date(
          now.getTime() + getProcessingDeferralMs(event.processingAttempts)
        ),
        lastProcessingError: reason
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
): Promise<{ event: ICommercePaidOrderEventDocument; claimId: string } | null> => {
  const claimId = randomUUID();
  const event = await CommercePaidOrderEvent.findOneAndUpdate(
    {
      status: { $in: ["received", "processing"] },
      $and: [
        {
          $or: [
            { nextProcessingAttemptAt: { $lte: now } },
            { nextProcessingAttemptAt: { $exists: false } }
          ]
        },
        {
          $or: [
            { status: "received" },
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
    {
      new: true,
      sort: { nextProcessingAttemptAt: 1, receivedAt: 1 }
    }
  );

  return event ? { event, claimId } : null;
};

const buildQueueIdempotencyKey = (
  businessId: string,
  eventId: string,
  notificationKind: string,
  normalizedRecipient: string
): string =>
  `commerce:${businessId}:${eventId}:${notificationKind}:${normalizedRecipient}`;

export const processNextCommercePaidOrderNotification = async (): Promise<boolean> => {
  const claimed = await claimNextEvent();
  if (!claimed) return false;

  const { event, claimId } = claimed;
  const businessId = String(event.businessId);

  try {
    const business = await Business.findById(event.businessId).select(
      "+whatsappIntegration.wasenderApiToken"
    );
    if (!business) {
      await deferClaimedEvent(event, claimId, "business_missing");
      return true;
    }

    const configurationReason = getCommerceNotificationConfigurationReason(business);
    if (configurationReason) {
      await deferClaimedEvent(event, claimId, configurationReason);
      return true;
    }

    const integration = business.whatsappIntegration!;
    const sessionId = integration.wasenderSessionId!;
    const apiKey = integration.wasenderApiToken!;
    const customerRecipient =
      normalizeGhanaPhone(event.order.customer.phone) ||
      event.order.customer.phone.trim();

    if (event.order.customer.whatsappConsent) {
      await enqueueWasenderMessage({
        businessId,
        sessionId,
        to: customerRecipient,
        type: "text",
        text: buildCustomerPaymentConfirmation(business.name, event),
        apiKey,
        idempotencyKey: buildQueueIdempotencyKey(
          businessId,
          event.eventId,
          "customer",
          customerRecipient
        ),
        metadata: {
          kind: commercePaidOrderCustomerNotificationKind,
          businessId,
          commerceEventId: event.eventId,
          recipientType: "customer"
        }
      });
    }

    const staffText = buildStaffPaidOrderNotification(business.name, event);
    for (const recipient of getNormalizedCommerceStaffRecipients(business)) {
      await enqueueWasenderMessage({
        businessId,
        sessionId,
        to: recipient,
        type: "text",
        text: staffText,
        apiKey,
        idempotencyKey: buildQueueIdempotencyKey(
          businessId,
          event.eventId,
          "staff",
          recipient
        ),
        metadata: {
          kind: commercePaidOrderStaffNotificationKind,
          businessId,
          commerceEventId: event.eventId,
          recipientType: "staff"
        }
      });
    }

    await CommercePaidOrderEvent.updateOne(
      {
        _id: event._id,
        status: "processing",
        processingClaimId: claimId
      },
      {
        $set: {
          status: "enqueued",
          enqueueCompletedAt: new Date()
        },
        $unset: {
          processingClaimId: "",
          processingLeaseExpiresAt: "",
          lastProcessingError: ""
        }
      }
    );
    return true;
  } catch {
    await deferClaimedEvent(event, claimId, "notification_enqueue_failed");
    console.error("Commerce paid-order notification enqueue failed", {
      businessId,
      commerceEventId: event.eventId
    });
    return true;
  }
};

export const startCommercePaidOrderNotificationWorker = (): void => {
  if (workerStarted) return;

  workerStarted = true;
  markRuntimeStarted("commerce_paid_order_notifications", workerIntervalMs);
  console.log(
    `[commercePaidOrderNotifications] Worker started (check every ${
      workerIntervalMs / 1000
    }s)`
  );

  const timer = setInterval(() => {
    if (workerBusy) return;

    workerBusy = true;
    markRuntimeRunStarted("commerce_paid_order_notifications");
    void processNextCommercePaidOrderNotification()
      .then(() => {
        markRuntimeRunSucceeded("commerce_paid_order_notifications");
      })
      .catch((error) => {
        markRuntimeRunFailed(
          "commerce_paid_order_notifications",
          "COMMERCE_NOTIFICATION_PASS_FAILED"
        );
        console.error("Commerce paid-order notification worker failed", {
          error: error instanceof Error ? error.message : "Unknown worker error"
        });
      })
      .finally(() => {
        workerBusy = false;
      });
  }, workerIntervalMs);

  timer.unref();
};
