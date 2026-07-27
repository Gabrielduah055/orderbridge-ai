import { Schema, model, type Document, type Types } from "mongoose";

export const outboundMessageTypes = ["text", "document"] as const;
export const outboundMessageStatuses = ["pending", "sending", "sent", "failed"] as const;

export type OutboundMessageType = (typeof outboundMessageTypes)[number];
export type OutboundMessageStatus = (typeof outboundMessageStatuses)[number];

export interface IOutboundMessage {
  restaurantId?: Types.ObjectId;
  sessionId: string;
  to: string;
  type: OutboundMessageType;
  text?: string;
  documentUrl?: string;
  caption?: string;
  apiKey?: string;
  status: OutboundMessageStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  sentAt?: Date;
  lastAttemptAt?: Date;
  lastError?: string;
  lastStatus?: number;
  providerData?: unknown;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export interface IOutboundMessageDocument extends IOutboundMessage, Document {
  createdAt: Date;
  updatedAt: Date;
}

const outboundMessageSchema = new Schema<IOutboundMessageDocument>(
  {
    restaurantId: {
      type: Schema.Types.ObjectId,
      ref: "Restaurant",
      index: true
    },
    sessionId: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    to: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    type: {
      type: String,
      enum: outboundMessageTypes,
      required: true
    },
    text: {
      type: String
    },
    documentUrl: {
      type: String,
      trim: true
    },
    caption: {
      type: String
    },
    apiKey: {
      type: String,
      trim: true,
      select: false
    },
    status: {
      type: String,
      enum: outboundMessageStatuses,
      default: "pending",
      index: true
    },
    attempts: {
      type: Number,
      default: 0,
      min: 0
    },
    maxAttempts: {
      type: Number,
      default: 5,
      min: 1
    },
    nextAttemptAt: {
      type: Date,
      required: true,
      default: Date.now,
      index: true
    },
    sentAt: {
      type: Date
    },
    lastAttemptAt: {
      type: Date
    },
    lastError: {
      type: String,
      trim: true
    },
    lastStatus: {
      type: Number
    },
    providerData: {
      type: Schema.Types.Mixed
    },
    idempotencyKey: {
      type: String,
      trim: true,
      unique: true,
      sparse: true
    },
    metadata: {
      type: Schema.Types.Mixed
    }
  },
  {
    timestamps: true
  }
);

outboundMessageSchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 });
outboundMessageSchema.index({ sessionId: 1, sentAt: -1 });

export const OutboundMessage = model<IOutboundMessageDocument>(
  "OutboundMessage",
  outboundMessageSchema
);
