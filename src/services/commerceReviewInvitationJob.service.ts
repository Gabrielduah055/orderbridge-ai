import { CommercePaidOrderEvent } from "../models/commercePaidOrderEvent.model";
import {
  CommerceReviewInvitationJob,
  type ICommerceReviewInvitationJobDocument
} from "../models/commerceReviewInvitationJob.model";
import { OutboundMessage } from "../models/outboundMessage.model";
import { normalizeGhanaPhone } from "../utils/phone.util";
import { commercePaidOrderReceiptNotificationKind } from "./commerceNotificationConfiguration.service";

export const ensureCommerceReviewInvitationJobForSentReceipt = async (
  receiptOutboundMessageId: string
): Promise<ICommerceReviewInvitationJobDocument | null> => {
  const receiptMessage = await OutboundMessage.findOne({
    _id: receiptOutboundMessageId,
    status: "sent",
    "metadata.kind": commercePaidOrderReceiptNotificationKind,
    "metadata.reviewInvitationEligible": true
  });
  if (!receiptMessage?.businessId) return null;

  const businessId = String(receiptMessage.businessId);
  const commerceEventId =
    typeof receiptMessage.metadata?.commerceEventId === "string"
      ? receiptMessage.metadata.commerceEventId
      : "";
  if (!commerceEventId) return null;

  const event = await CommercePaidOrderEvent.findOne({
    businessId,
    eventId: commerceEventId,
    status: "enqueued"
  });
  if (!event) return null;

  const customerRecipient = normalizeGhanaPhone(event.order.customer.phone);
  if (!customerRecipient || normalizeGhanaPhone(receiptMessage.to) !== customerRecipient) {
    return null;
  }

  let job: ICommerceReviewInvitationJobDocument;
  try {
    const upsertedJob = await CommerceReviewInvitationJob.findOneAndUpdate(
      {
        businessId,
        externalOrderId: event.order.externalOrderId,
        customerRecipient
      },
      {
        $setOnInsert: {
          businessId,
          commerceEventId,
          externalOrderId: event.order.externalOrderId,
          customerRecipient,
          receiptOutboundMessageId: receiptMessage._id,
          status: "pending",
          attempts: 0,
          maxAttempts: 8,
          nextAttemptAt: new Date()
        }
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    if (!upsertedJob) {
      throw new Error("Review invitation job upsert returned no record");
    }
    job = upsertedJob;
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      (error as { code?: number }).code !== 11000
    ) {
      throw error;
    }
    const racedJob = await CommerceReviewInvitationJob.findOne({
      businessId,
      externalOrderId: event.order.externalOrderId,
      customerRecipient
    });
    if (!racedJob) throw error;
    job = racedJob;
  }

  await OutboundMessage.updateOne(
    {
      _id: receiptMessage._id,
      status: "sent",
      "metadata.reviewInvitationEligible": true
    },
    {
      $set: {
        "metadata.reviewInvitationJobId": String(job._id),
        "metadata.reviewInvitationJobCreatedAt": new Date()
      }
    }
  );

  return job;
};
