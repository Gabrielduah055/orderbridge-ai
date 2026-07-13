import { Schema, model, type Document } from "mongoose";
import {
  assistantTones,
  billingStatuses,
  restaurantPlans,
  restaurantStatuses,
  type AssistantTone,
  type BillingStatus,
  type RestaurantPlan,
  type RestaurantStatus
} from "../types/restaurant.types";

export interface IRestaurant {
  name: string;
  slug: string;
  ownerName?: string;
  ownerPhone: string;
  contactEmail?: string;
  primaryCuisine?: string;
  managerPhones: string[];
  managerContacts: RestaurantManagerContact[];
  plan: RestaurantPlan;
  status: RestaurantStatus;
  subscriptionRenewalDate?: Date;
  subscriptionAmount?: number;
  billingStatus?: BillingStatus;
  wasenderSessionId: string;
  wasenderApiToken?: string;
  whatsappNumber: string;
  openingHours?: string;
  pickupAddress?: string;
  deliveryEnabled: boolean;
  deliveryAreas: string[];
  deliveryRadiusKm?: number;
  minimumOrderValue?: number;
  allowTakeaway: boolean;
  freeDeliveryThresholdEnabled: boolean;
  deliveryFeeNote?: string;
  assistantTone: AssistantTone;
  assistantPersonalitySummary?: string;
  followUpEnabled: boolean;
  followUpDelayMinutes: number;
}

export interface RestaurantManagerContact {
  name?: string;
  phone: string;
}

export interface IRestaurantDocument extends IRestaurant, Document {
  createdAt: Date;
  updatedAt: Date;
}

const restaurantSchema = new Schema<IRestaurantDocument>(
  {
    name: {
      type: String,
      required: true,
      trim: true
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true
    },
    ownerName: {
      type: String,
      trim: true
    },
    ownerPhone: {
      type: String,
      required: true,
      trim: true
    },
    contactEmail: {
      type: String,
      trim: true,
      lowercase: true
    },
    primaryCuisine: {
      type: String,
      trim: true
    },
    managerPhones: {
      type: [String],
      default: []
    },
    managerContacts: {
      type: [
        {
          name: {
            type: String,
            trim: true
          },
          phone: {
            type: String,
            required: true,
            trim: true
          }
        }
      ],
      default: []
    },
    plan: {
      type: String,
      enum: restaurantPlans,
      default: "starter"
    },
    status: {
      type: String,
      enum: restaurantStatuses,
      default: "trial"
    },
    subscriptionRenewalDate: {
      type: Date
    },
    subscriptionAmount: {
      type: Number,
      min: 0
    },
    billingStatus: {
      type: String,
      enum: billingStatuses
    },
    wasenderSessionId: {
      type: String,
      required: true,
      trim: true
    },
    wasenderApiToken: {
      type: String,
      trim: true,
      select: false
    },
    whatsappNumber: {
      type: String,
      required: true,
      trim: true
    },
    openingHours: {
      type: String,
      trim: true
    },
    pickupAddress: {
      type: String,
      trim: true
    },
    deliveryEnabled: {
      type: Boolean,
      default: false
    },
    deliveryAreas: {
      type: [String],
      default: []
    },
    deliveryRadiusKm: {
      type: Number,
      min: 0
    },
    minimumOrderValue: {
      type: Number,
      min: 0
    },
    allowTakeaway: {
      type: Boolean,
      default: false
    },
    freeDeliveryThresholdEnabled: {
      type: Boolean,
      default: false
    },
    deliveryFeeNote: {
      type: String,
      trim: true
    },
    assistantTone: {
      type: String,
      enum: assistantTones,
      default: "friendly"
    },
    assistantPersonalitySummary: {
      type: String,
      trim: true
    },
    followUpEnabled: {
      type: Boolean,
      default: true
    },
    followUpDelayMinutes: {
      type: Number,
      default: 5,
      min: 0
    }
  },
  {
    timestamps: true
  }
);

export const Restaurant = model<IRestaurantDocument>("Restaurant", restaurantSchema);
