import { Schema, model, type Document, type Types } from "mongoose";

export const orderFeedbackTypes = [
  "review",
  "complaint",
  "suggestion",
  "system_feedback",
  "delivery_not_received",
  "mixed"
] as const;

export const orderFeedbackSentiments = [
  "positive",
  "neutral",
  "negative",
  "mixed"
] as const;

export type OrderFeedbackType = (typeof orderFeedbackTypes)[number];
export type OrderFeedbackSentiment = (typeof orderFeedbackSentiments)[number];

export interface IOrderFeedback {
  restaurantId: Types.ObjectId;
  orderId: Types.ObjectId;
  orderNumber: string;
  customerPhone: string;
  customerName?: string;
  type: OrderFeedbackType;
  message: string;
  summary?: string;
  sentiment?: OrderFeedbackSentiment;
  rating?: number;
  requiresOwnerAttention: boolean;
  inboundEventId?: string;
  ownerNotifiedAt?: Date;
  ownerNotificationFailedAt?: Date;
  ownerNotificationFailureReason?: string;
  resolvedAt?: Date;
  resolvedByPhone?: string;
}

export interface IOrderFeedbackDocument extends IOrderFeedback, Document {
  createdAt: Date;
  updatedAt: Date;
}

const orderFeedbackSchema = new Schema<IOrderFeedbackDocument>(
  {
    restaurantId: {
      type: Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true
    },
    orderId: {
      type: Schema.Types.ObjectId,
      ref: "Order",
      required: true
    },
    orderNumber: {
      type: String,
      required: true,
      trim: true
    },
    customerPhone: {
      type: String,
      required: true,
      trim: true
    },
    customerName: {
      type: String,
      trim: true
    },
    type: {
      type: String,
      enum: orderFeedbackTypes,
      required: true
    },
    message: {
      type: String,
      required: true,
      trim: true
    },
    summary: {
      type: String,
      trim: true
    },
    sentiment: {
      type: String,
      enum: orderFeedbackSentiments
    },
    rating: {
      type: Number,
      min: 1,
      max: 5
    },
    requiresOwnerAttention: {
      type: Boolean,
      required: true,
      default: false
    },
    inboundEventId: {
      type: String,
      trim: true
    },
    ownerNotifiedAt: {
      type: Date
    },
    ownerNotificationFailedAt: {
      type: Date
    },
    ownerNotificationFailureReason: {
      type: String,
      trim: true
    },
    resolvedAt: {
      type: Date
    },
    resolvedByPhone: {
      type: String,
      trim: true
    }
  },
  {
    timestamps: true
  }
);

orderFeedbackSchema.index({ restaurantId: 1, createdAt: -1 });
orderFeedbackSchema.index({ restaurantId: 1, type: 1, createdAt: -1 });
orderFeedbackSchema.index({ restaurantId: 1, orderId: 1 });
orderFeedbackSchema.index({
  restaurantId: 1,
  requiresOwnerAttention: 1,
  resolvedAt: 1
});
orderFeedbackSchema.index(
  { restaurantId: 1, inboundEventId: 1 },
  {
    unique: true,
    sparse: true
  }
);

export const OrderFeedback = model<IOrderFeedbackDocument>(
  "OrderFeedback",
  orderFeedbackSchema
);
