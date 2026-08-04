import { Schema, model, type Document, type Types } from "mongoose";

export const orderTypes = ["pickup", "delivery"] as const;
export const orderStatuses = [
  "collecting_details",
  "awaiting_delivery_fee",
  "awaiting_customer_confirmation",
  "awaiting_restaurant_confirmation",
  "pending",
  "confirmed",
  "accepted",
  "expired",
  "rejected",
  "preparing",
  "ready",
  "out_for_delivery",
  "completed",
  "cancelled"
] as const;
export const paymentMethods = ["cash", "momo", "card", "unknown"] as const;
export const paymentStatuses = ["unpaid", "paid", "pending"] as const;

export type OrderType = (typeof orderTypes)[number];
export type OrderStatus = (typeof orderStatuses)[number];
export type PaymentMethod = (typeof paymentMethods)[number];
export type PaymentStatus = (typeof paymentStatuses)[number];

export interface IOrderItem {
  menuItemId: Types.ObjectId;
  name: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}

export interface IOrder {
  restaurantId: Types.ObjectId;
  customerName?: string;
  customerPhone: string;
  items: IOrderItem[];
  subtotal: number;
  deliveryFee?: number | null;
  deliveryFeeSource?: string;
  deliveryFeePending?: boolean;
  deliveryFeeResolvedAt?: Date;
  total: number;
  orderType: OrderType;
  deliveryAddress?: string;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  notes?: string;
  sourceDraftId?: Types.ObjectId;
  receiptUrl?: string;
  receiptGeneratedAt?: Date;
  receiptGenerationFailedAt?: Date;
  receiptGenerationFailureReason?: string;
  receiptSentAt?: Date;
  receiptDeliveryFailedAt?: Date;
  receiptDeliveryFailureReason?: string;
  customerConfirmedAt?: Date;
  ownerNotifiedAt?: Date;
  ownerNotificationProviderMessageId?: string;
  ownerNotificationFailedAt?: Date;
  ownerNotificationFailureReason?: string;
  restaurantConfirmedAt?: Date;
  restaurantRejectedAt?: Date;
  restaurantRejectionReason?: string;
  customerConfirmedNotificationSentAt?: Date;
  rejectionNotificationSentAt?: Date;
  customerNotificationFailedAt?: Date;
  customerNotificationFailureReason?: string;
  completedAt?: Date;
  orderNumber?: string;
  deliveryFollowUpSentAt?: Date;
  ownerCompletionNotifiedAt?: Date;
}

export interface IOrderDocument extends IOrder, Document {
  createdAt: Date;
  updatedAt: Date;
}

const orderItemSchema = new Schema<IOrderItem>(
  {
    menuItemId: {
      type: Schema.Types.ObjectId,
      ref: "MenuItem",
      required: true
    },
    name: {
      type: String,
      required: true,
      trim: true
    },
    quantity: {
      type: Number,
      required: true,
      min: 1
    },
    unitPrice: {
      type: Number,
      required: true,
      min: 0
    },
    totalPrice: {
      type: Number,
      required: true,
      min: 0
    }
  },
  {
    _id: false
  }
);

const orderSchema = new Schema<IOrderDocument>(
  {
    restaurantId: {
      type: Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true,
      index: true
    },
    customerName: {
      type: String,
      trim: true
    },
    customerPhone: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    items: {
      type: [orderItemSchema],
      required: true,
      validate: {
        validator: (items: IOrderItem[]) => items.length > 0,
        message: "Order must include at least one item"
      }
    },
    subtotal: {
      type: Number,
      required: true,
      min: 0
    },
    deliveryFee: {
      type: Number,
      min: 0,
      default: undefined
    },
    deliveryFeeSource: {
      type: String,
      trim: true
    },
    deliveryFeePending: {
      type: Boolean,
      default: false,
      index: true
    },
    deliveryFeeResolvedAt: {
      type: Date
    },
    total: {
      type: Number,
      required: true,
      min: 0
    },
    orderType: {
      type: String,
      enum: orderTypes,
      required: true
    },
    deliveryAddress: {
      type: String,
      trim: true
    },
    status: {
      type: String,
      enum: orderStatuses,
      default: "pending"
    },
    paymentMethod: {
      type: String,
      enum: paymentMethods,
      default: "unknown"
    },
    paymentStatus: {
      type: String,
      enum: paymentStatuses,
      default: "unpaid"
    },
    notes: {
      type: String,
      trim: true
    },
    sourceDraftId: {
      type: Schema.Types.ObjectId,
      ref: "CustomerSession",
      unique: true,
      sparse: true
    },
    receiptUrl: {
      type: String,
      trim: true
    },
    receiptGeneratedAt: {
      type: Date
    },
    receiptGenerationFailedAt: {
      type: Date
    },
    receiptGenerationFailureReason: {
      type: String,
      trim: true
    },
    receiptSentAt: {
      type: Date
    },
    receiptDeliveryFailedAt: {
      type: Date
    },
    receiptDeliveryFailureReason: {
      type: String,
      trim: true
    },
    customerConfirmedAt: {
      type: Date
    },
    ownerNotifiedAt: {
      type: Date
    },
    ownerNotificationProviderMessageId: {
      type: String,
      trim: true,
      index: true
    },
    ownerNotificationFailedAt: {
      type: Date
    },
    ownerNotificationFailureReason: {
      type: String,
      trim: true
    },
    restaurantConfirmedAt: {
      type: Date
    },
    restaurantRejectedAt: {
      type: Date
    },
    restaurantRejectionReason: {
      type: String,
      trim: true
    },
    customerConfirmedNotificationSentAt: {
      type: Date
    },
    rejectionNotificationSentAt: {
      type: Date
    },
    customerNotificationFailedAt: {
      type: Date
    },
    customerNotificationFailureReason: {
      type: String,
      trim: true
    },
    completedAt: {
      type: Date
    },
    orderNumber: {
      type: String,
      trim: true,
      unique: true,
      sparse: true
    },
    deliveryFollowUpSentAt: {
      type: Date
    },
    ownerCompletionNotifiedAt: {
      type: Date
    }
  },
  {
    timestamps: true
  }
);

orderSchema.index({ restaurantId: 1, createdAt: -1 });
orderSchema.index({ restaurantId: 1, status: 1 });
orderSchema.index({
  restaurantId: 1,
  customerPhone: 1,
  status: 1,
  completedAt: -1
});

orderSchema.pre("validate", function setOrderNumber(next) {
  if (!this.orderNumber) {
    this.orderNumber = `ORD-${Date.now()}`;
  }

  next();
});

export const Order = model<IOrderDocument>("Order", orderSchema);
