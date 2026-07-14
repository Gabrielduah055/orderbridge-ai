import { Schema, model, type Document } from "mongoose";

export const webhookEventStatuses = ["processing", "processed", "failed"] as const;

export type WebhookEventStatus = (typeof webhookEventStatuses)[number];

export interface IWebhookEvent {
  provider: "wasender";
  eventId: string;
  sessionId?: string;
  from?: string;
  payload: Record<string, unknown>;
  processedAt?: Date;
  status: WebhookEventStatus;
  failureReason?: string;
  failureDetails?: Record<string, unknown>;
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
    }
  },
  {
    timestamps: true
  }
);

webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });

export const WebhookEvent = model<IWebhookEventDocument>(
  "WebhookEvent",
  webhookEventSchema
);
