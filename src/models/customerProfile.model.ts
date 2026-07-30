import { Schema, model, type Document, type Types } from "mongoose";
import { orderTypes, type OrderType } from "./order.model";

export const customerProfileValueSources = [
  "completed_order",
  "customer_confirmed"
] as const;

export type CustomerProfileValueSource =
  (typeof customerProfileValueSources)[number];

export interface IFrequentlyOrderedItem {
  menuItemId: Types.ObjectId;
  name: string;
  orderCount: number;
  totalQuantity: number;
  lastOrderedAt: Date;
}

export interface ICommonDeliveryAddress {
  address: string;
  orderCount: number;
  lastUsedAt: Date;
}

export interface ICustomerProfile {
  restaurantId: Types.ObjectId;
  customerPhone: string;
  customerName?: string;
  customerNameSource?: CustomerProfileValueSource;
  orderCount: number;
  lastOrderAt?: Date;
  averageOrderValue: number;
  frequentlyOrderedItems: IFrequentlyOrderedItem[];
  preferredOrderType?: OrderType;
  preferredOrderTypeSource?: CustomerProfileValueSource;
  commonDeliveryAddresses: ICommonDeliveryAddress[];
  dietaryPreferences: string[];
  spicePreference?: string | null;
  marketingConsent?: boolean | null;
  isOptedOut?: boolean | null;
  preferencesConfirmedAt?: Date;
}

export interface ICustomerProfileDocument extends ICustomerProfile, Document {
  createdAt: Date;
  updatedAt: Date;
}

const frequentlyOrderedItemSchema = new Schema<IFrequentlyOrderedItem>(
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
    orderCount: {
      type: Number,
      required: true,
      min: 1
    },
    totalQuantity: {
      type: Number,
      required: true,
      min: 1
    },
    lastOrderedAt: {
      type: Date,
      required: true
    }
  },
  {
    _id: false
  }
);

const commonDeliveryAddressSchema = new Schema<ICommonDeliveryAddress>(
  {
    address: {
      type: String,
      required: true,
      trim: true
    },
    orderCount: {
      type: Number,
      required: true,
      min: 1
    },
    lastUsedAt: {
      type: Date,
      required: true
    }
  },
  {
    _id: false
  }
);

const customerProfileSchema = new Schema<ICustomerProfileDocument>(
  {
    restaurantId: {
      type: Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true
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
    customerNameSource: {
      type: String,
      enum: customerProfileValueSources
    },
    orderCount: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    lastOrderAt: {
      type: Date
    },
    averageOrderValue: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    frequentlyOrderedItems: {
      type: [frequentlyOrderedItemSchema],
      default: []
    },
    preferredOrderType: {
      type: String,
      enum: orderTypes
    },
    preferredOrderTypeSource: {
      type: String,
      enum: customerProfileValueSources
    },
    commonDeliveryAddresses: {
      type: [commonDeliveryAddressSchema],
      default: []
    },
    dietaryPreferences: {
      type: [String],
      default: []
    },
    spicePreference: {
      type: String,
      trim: true,
      default: null
    },
    marketingConsent: {
      type: Boolean,
      default: null
    },
    isOptedOut: {
      type: Boolean,
      default: null
    },
    preferencesConfirmedAt: {
      type: Date
    }
  },
  {
    timestamps: true
  }
);

customerProfileSchema.index(
  { restaurantId: 1, customerPhone: 1 },
  { unique: true }
);
customerProfileSchema.index({ restaurantId: 1, lastOrderAt: -1 });
customerProfileSchema.index({ restaurantId: 1, orderCount: -1 });
customerProfileSchema.index({
  restaurantId: 1,
  marketingConsent: 1,
  isOptedOut: 1
});

export const CustomerProfile = model<ICustomerProfileDocument>(
  "CustomerProfile",
  customerProfileSchema
);
