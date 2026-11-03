import { Schema, model, type Document, type Types } from "mongoose";

export const webhookEventStatuses = [
  "received",
  "processing",
  "processed",
  "failed"
] as const;

export type WebhookEventStatus = (typeof webhookEventStatuses)[number];

export interface IWebhookEvent {
  provider: "wasender";
  eventId: string;
  eventKind?: "commerce_chat";
  businessId?: Types.ObjectId;
  providerMessageId?: string;
  sessionId?: string;
  from?: string;
  payload: Record<string, unknown>;
  processedAt?: Date;
  status: WebhookEventStatus;
  failureReason?: string;
  failureDetails?: Record<string, unknown>;
  processingAttempts?: number;
  nextProcessingAttemptAt?: Date;
  processingClaimId?: string;
  processingLeaseExpiresAt?: Date;
  lastProcessingAttemptAt?: Date;
  customerKey?: string;
  recipientAddress?: string;
  conversationId?: string;
  generatedReply?: string;
  replyGeneratedAt?: Date;
  enqueueCompletedAt?: Date;
}

export interface IWebhookEventDocument extends IWebhookEvent, Document {
  createdAt: Date;
  updatedAt: Date;
}

const webhookEventSchema = new Schema<IWebhookEventDocument>(
  {
    provider: {
      type: String,
      enum: ["wasender"],
      required: true,
      index: true
    },
    eventId: {
      type: String,
      required: true,
      trim: true
    },
    eventKind: {
      type: String,
      enum: ["commerce_chat"],
      index: true
    },
    businessId: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      index: true
    },
    providerMessageId: { type: String, trim: true },
    sessionId: {
      type: String,
      trim: true
    },
    from: {
      type: String,
      trim: true
    },
    payload: {
      type: Schema.Types.Mixed,
      required: true
    },
    processedAt: {
      type: Date
    },
    status: {
      type: String,
      enum: webhookEventStatuses,
      default: "processing"
    },
    failureReason: {
      type: String,
      trim: true
    },
    failureDetails: {
      type: Schema.Types.Mixed
    },
    processingAttempts: { type: Number, min: 0, default: 0 },
    nextProcessingAttemptAt: { type: Date, default: Date.now },
    processingClaimId: { type: String, trim: true },
    processingLeaseExpiresAt: { type: Date },
    lastProcessingAttemptAt: { type: Date },
    customerKey: { type: String, trim: true },
    recipientAddress: { type: String, trim: true },
    conversationId: { type: String, trim: true },
    generatedReply: { type: String },
    replyGeneratedAt: { type: Date },
    enqueueCompletedAt: { type: Date }
  },
  {
    timestamps: true
  }
);

webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });
webhookEventSchema.index({ sessionId: 1, createdAt: -1 });
webhookEventSchema.index({ sessionId: 1, processedAt: -1 });
webhookEventSchema.index({ sessionId: 1, updatedAt: -1 });
webhookEventSchema.index(
  {
    eventKind: 1,
    status: 1,
    nextProcessingAttemptAt: 1,
    processingLeaseExpiresAt: 1,
    createdAt: 1
  },
  { name: "commerce_webhook_processing_claim" }
);

export const WebhookEvent = model<IWebhookEventDocument>(
  "WebhookEvent",
  webhookEventSchema
);

export const ensureWebhookEventIndexes = async (): Promise<void> => {
  await WebhookEvent.collection.createIndex(
    { provider: 1, eventId: 1 },
    { unique: true, name: "provider_1_eventId_1" }
  );
  await WebhookEvent.collection.createIndex(
    {
      eventKind: 1,
      status: 1,
      nextProcessingAttemptAt: 1,
      processingLeaseExpiresAt: 1,
      createdAt: 1
    },
    { name: "commerce_webhook_processing_claim" }
  );
};
