import { Schema, model, type Document, type Types } from "mongoose";

export const commerceReviewInvitationJobStatuses = [
  "pending",
  "processing",
  "enqueued",
  "sent",
  "skipped",
  "failed"
] as const;

export type CommerceReviewInvitationJobStatus =
  (typeof commerceReviewInvitationJobStatuses)[number];

export interface ICommerceReviewInvitationJob {
  businessId: Types.ObjectId;
  commerceEventId: string;
  externalOrderId: string;
  customerRecipient: string;
  receiptOutboundMessageId: Types.ObjectId;
  invitationOutboundMessageId?: Types.ObjectId;
  status: CommerceReviewInvitationJobStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  claimId?: string;
  leaseExpiresAt?: Date;
  lastAttemptAt?: Date;
  lastErrorCode?: string;
  completedAt?: Date;
}

export interface ICommerceReviewInvitationJobDocument
  extends ICommerceReviewInvitationJob,
    Document {
  createdAt: Date;
  updatedAt: Date;
}

const commerceReviewInvitationJobSchema =
  new Schema<ICommerceReviewInvitationJobDocument>(
    {
      businessId: {
        type: Schema.Types.ObjectId,
        ref: "Business",
        required: true
      },
      commerceEventId: { type: String, required: true, trim: true },
      externalOrderId: { type: String, required: true, trim: true },
      customerRecipient: { type: String, required: true, trim: true },
      receiptOutboundMessageId: {
        type: Schema.Types.ObjectId,
        ref: "OutboundMessage",
        required: true
      },
      invitationOutboundMessageId: {
        type: Schema.Types.ObjectId,
        ref: "OutboundMessage"
      },
      status: {
        type: String,
        enum: commerceReviewInvitationJobStatuses,
        required: true,
        default: "pending"
      },
      attempts: { type: Number, required: true, default: 0, min: 0 },
      maxAttempts: { type: Number, required: true, default: 8, min: 1 },
      nextAttemptAt: { type: Date, required: true, default: Date.now },
      claimId: { type: String, trim: true },
      leaseExpiresAt: { type: Date },
      lastAttemptAt: { type: Date },
      lastErrorCode: { type: String, trim: true },
      completedAt: { type: Date }
    },
    {
      timestamps: true,
      strict: true,
      versionKey: false
    }
  );

commerceReviewInvitationJobSchema.index(
  { businessId: 1, externalOrderId: 1, customerRecipient: 1 },
  { unique: true, name: "commerce_review_invitation_scope_unique" }
);
commerceReviewInvitationJobSchema.index(
  { status: 1, nextAttemptAt: 1, leaseExpiresAt: 1, createdAt: 1 },
  { name: "commerce_review_invitation_claim" }
);
commerceReviewInvitationJobSchema.index(
  { receiptOutboundMessageId: 1 },
  { unique: true, name: "commerce_review_invitation_receipt_unique" }
);

export const CommerceReviewInvitationJob =
  model<ICommerceReviewInvitationJobDocument>(
    "CommerceReviewInvitationJob",
    commerceReviewInvitationJobSchema
  );

export const ensureCommerceReviewInvitationJobIndexes = async (): Promise<void> => {
  await CommerceReviewInvitationJob.collection.createIndex(
    { businessId: 1, externalOrderId: 1, customerRecipient: 1 },
    { unique: true, name: "commerce_review_invitation_scope_unique" }
  );
  await CommerceReviewInvitationJob.collection.createIndex(
    { status: 1, nextAttemptAt: 1, leaseExpiresAt: 1, createdAt: 1 },
    { name: "commerce_review_invitation_claim" }
  );
  await CommerceReviewInvitationJob.collection.createIndex(
    { receiptOutboundMessageId: 1 },
    { unique: true, name: "commerce_review_invitation_receipt_unique" }
  );
};
