import { Schema, model, type Document, type Types } from "mongoose";
import { orderTypes, type OrderType } from "./order.model";

export const customerSessionSteps = [
  "idle",
  "choosing_items",
  "selecting_item_from_category",
  "collecting_quantity",
  "choosing_order_type",
  "collecting_address",
  "collecting_name",
  "awaiting_delivery_fee",
  "confirming_order"
] as const;

export type CustomerSessionStep = (typeof customerSessionSteps)[number];

export interface ICustomerSessionCartItem {
  menuItemId: Types.ObjectId;
  name: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}

export interface ICustomerSession {
  restaurantId: Types.ObjectId;
  customerPhone: string;
  customerName?: string;
  cartItems: ICustomerSessionCartItem[];
  pendingMenuItemId?: Types.ObjectId;
  pendingMenuItemName?: string;
  pendingCategoryId?: Types.ObjectId;
  pendingCategoryName?: string;
  currentStep: CustomerSessionStep;
  orderType: OrderType | null;
  deliveryAddress?: string;
  deliveryFee?: number;
  deliveryFeeSource?: string;
  deliveryFeeResolved: boolean;
  convertedOrderId?: Types.ObjectId;
  convertedAt?: Date;
  lastMessage?: string;
  lastInboundEventId?: string;
  conversationVersion: number;
  lastFollowUpKey?: string;
  lastFollowUpAt?: Date;
  expiresAt: Date;
}

export interface ICustomerSessionDocument extends ICustomerSession, Document {
  createdAt: Date;
  updatedAt: Date;
}

const customerSessionCartItemSchema = new Schema<ICustomerSessionCartItem>(
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

const customerSessionSchema = new Schema<ICustomerSessionDocument>(
  {
    restaurantId: {
      type: Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true,
      index: true
    },
    customerPhone: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    customerName: {
      type: String,
      trim: true
    },
    cartItems: {
      type: [customerSessionCartItemSchema],
      default: []
    },
    pendingMenuItemId: {
      type: Schema.Types.ObjectId,
      ref: "MenuItem"
    },
    pendingMenuItemName: {
      type: String,
      trim: true
    },
    pendingCategoryId: {
      type: Schema.Types.ObjectId,
      ref: "MenuCategory"
    },
    pendingCategoryName: {
      type: String,
      trim: true
    },
    currentStep: {
      type: String,
      enum: customerSessionSteps,
      default: "idle"
    },
    orderType: {
      type: String,
      enum: [...orderTypes, null],
      default: null
    },
    deliveryAddress: {
      type: String,
      trim: true
    },
    deliveryFee: {
      type: Number,
      min: 0
    },
    deliveryFeeSource: {
      type: String,
      trim: true
    },
    deliveryFeeResolved: {
      type: Boolean,
      default: false
    },
    convertedOrderId: {
      type: Schema.Types.ObjectId,
      ref: "Order"
    },
    convertedAt: {
      type: Date
    },
    lastMessage: {
      type: String,
      trim: true
    },
    lastInboundEventId: {
      type: String,
      trim: true
    },
    conversationVersion: {
      type: Number,
      default: 0,
      min: 0
    },
    lastFollowUpKey: {
      type: String,
      trim: true
    },
    lastFollowUpAt: {
      type: Date
    },
    expiresAt: {
      type: Date,
      required: true,
      index: {
        expires: 0
      }
    }
  },
  {
    timestamps: true
  }
);

customerSessionSchema.index({ restaurantId: 1, customerPhone: 1 }, { unique: true });

export const CustomerSession = model<ICustomerSessionDocument>(
  "CustomerSession",
  customerSessionSchema
);
