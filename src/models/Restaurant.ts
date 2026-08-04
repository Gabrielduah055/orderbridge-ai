import { Schema, model, type Document } from "mongoose";
import {
  assistantTones,
  billingStatuses,
  restaurantPlans,
  restaurantStatuses,
  ownerSummaryWeekdays,
  type AssistantTone,
  type BillingStatus,
  type OwnerSummaryWeekday,
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
  deliveryPricing?: RestaurantDeliveryPricing;
  minimumOrderValue?: number;
  allowTakeaway: boolean;
  freeDeliveryThresholdEnabled: boolean;
  deliveryFeeNote?: string;
  assistantTone: AssistantTone;
  assistantPersonalitySummary?: string;
  followUpEnabled: boolean;
  followUpDelayMinutes: number;
  timezone: string;
  ownerDailySummaryEnabled: boolean;
  ownerDailySummaryTime: string;
  ownerWeeklySummaryEnabled: boolean;
  ownerWeeklySummaryDay: OwnerSummaryWeekday;
  ownerWeeklySummaryTime: string;
  ownerPendingActionReminderEnabled: boolean;
  ownerPendingActionReminderDelayMinutes: number;
  postDeliveryFollowUpEnabled: boolean;
  postDeliveryFollowUpDelayMinutes: number;
}

export interface RestaurantManagerContact {
  name?: string;
  phone: string;
}

export interface RestaurantDeliveryPricingZone {
  name: string;
  aliases?: string[];
  fee: number;
}

export interface RestaurantDeliveryPricing {
  type: "flat" | "zone_based" | "manual_confirmation";
  flatFee?: number;
  freeDeliveryThreshold?: number;
  zones?: RestaurantDeliveryPricingZone[];
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
    deliveryPricing: {
      type: new Schema(
        {
          type: {
            type: String,
            enum: ["flat", "zone_based", "manual_confirmation"],
            required: true
          },
          flatFee: {
            type: Number,
            min: 0
          },
          freeDeliveryThreshold: {
            type: Number,
            min: 0
          },
          zones: {
            type: [
              {
                name: {
                  type: String,
                  required: true,
                  trim: true
                },
                aliases: {
                  type: [String],
                  default: []
                },
                fee: {
                  type: Number,
                  required: true,
                  min: 0
                }
              }
            ],
            default: []
          }
        },
        { _id: false }
      )
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
      default: 3,
      min: 0
    },
    timezone: {
      type: String,
      default: "Africa/Accra",
      trim: true,
      validate: {
        validator: (value: string) => {
          try {
            new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
            return true;
          } catch {
            return false;
          }
        },
        message: "timezone must be a valid IANA timezone"
      }
    },
    ownerDailySummaryEnabled: {
      type: Boolean,
      default: true
    },
    ownerDailySummaryTime: {
      type: String,
      default: "08:00",
      match: /^(?:[01]\d|2[0-3]):[0-5]\d$/
    },
    ownerWeeklySummaryEnabled: {
      type: Boolean,
      default: true
    },
    ownerWeeklySummaryDay: {
      type: String,
      enum: ownerSummaryWeekdays,
      default: "monday"
    },
    ownerWeeklySummaryTime: {
      type: String,
      default: "08:00",
      match: /^(?:[01]\d|2[0-3]):[0-5]\d$/
    },
    ownerPendingActionReminderEnabled: {
      type: Boolean,
      default: false
    },
    ownerPendingActionReminderDelayMinutes: {
      type: Number,
      default: 3,
      min: 1
    },
    postDeliveryFollowUpEnabled: {
      type: Boolean,
      default: true
    },
    postDeliveryFollowUpDelayMinutes: {
      type: Number,
      default: 45,
      min: 1
    }
  },
  {
    timestamps: true
  }
);

restaurantSchema.index({ status: 1, ownerDailySummaryEnabled: 1 });
restaurantSchema.index({ status: 1, ownerWeeklySummaryEnabled: 1 });
restaurantSchema.index({ status: 1, ownerPendingActionReminderEnabled: 1 });

export const Restaurant = model<IRestaurantDocument>("Restaurant", restaurantSchema);
