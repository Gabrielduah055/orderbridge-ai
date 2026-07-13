import { Schema, model, type Document, type Types } from "mongoose";
import { orderTypes, type OrderType } from "./order.model";

export const customerSessionSteps = [
  "idle",
  "choosing_items",
  "choosing_order_type",
  "collecting_address",
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
  currentStep: CustomerSessionStep;
  orderType: OrderType | null;
  deliveryAddress?: string;
  lastMessage?: string;
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
    lastMessage: {
      type: String,
      trim: true
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
