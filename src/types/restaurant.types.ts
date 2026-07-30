export const restaurantPlans = ["starter", "growth", "premium"] as const;
export const restaurantStatuses = ["trial", "active", "paused", "cancelled"] as const;
export const assistantTones = ["friendly", "professional", "casual", "concise", "playful"] as const;
export const billingStatuses = ["active", "inactive", "past_due", "cancelled"] as const;
export const ownerSummaryWeekdays = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday"
] as const;

export type RestaurantPlan = (typeof restaurantPlans)[number];
export type RestaurantStatus = (typeof restaurantStatuses)[number];
export type AssistantTone = (typeof assistantTones)[number];
export type BillingStatus = (typeof billingStatuses)[number];
export type OwnerSummaryWeekday = (typeof ownerSummaryWeekdays)[number];
export type DeliveryPricingType = "flat" | "zone_based" | "manual_confirmation";

export interface RestaurantDeliveryPricingZoneInput {
  name: string;
  aliases?: string[];
  fee: number;
}

export interface RestaurantDeliveryPricingInput {
  type: DeliveryPricingType;
  flatFee?: number;
  freeDeliveryThreshold?: number;
  zones?: RestaurantDeliveryPricingZoneInput[];
}

export type PlanFeatureName =
  | "maxMenuItems"
  | "maxStaffNumbers"
  | "autoFollowUp"
  | "receiptPdf"
  | "foodImages"
  | "dailyReport"
  | "promotions"
  | "scheduledPromos"
  | "analytics"
  | "advancedReports";

export interface RestaurantInput {
  name: string;
  ownerName?: string;
  ownerPhone: string;
  contactEmail?: string;
  primaryCuisine?: string;
  managerPhones?: string[];
  managerContacts?: RestaurantManagerContactInput[];
  plan?: RestaurantPlan;
  status?: RestaurantStatus;
  subscriptionRenewalDate?: Date;
  subscriptionAmount?: number;
  billingStatus?: BillingStatus;
  wasenderSessionId: string;
  wasenderApiToken?: string;
  whatsappNumber: string;
  openingHours?: string;
  pickupAddress?: string;
  deliveryEnabled?: boolean;
  deliveryAreas?: string[];
  deliveryRadiusKm?: number;
  deliveryPricing?: RestaurantDeliveryPricingInput;
  minimumOrderValue?: number;
  allowTakeaway?: boolean;
  freeDeliveryThresholdEnabled?: boolean;
  deliveryFeeNote?: string;
  assistantTone?: AssistantTone;
  assistantPersonalitySummary?: string;
  followUpEnabled?: boolean;
  followUpDelayMinutes?: number;
  timezone?: string;
  ownerDailySummaryEnabled?: boolean;
  ownerDailySummaryTime?: string;
  ownerWeeklySummaryEnabled?: boolean;
  ownerWeeklySummaryDay?: OwnerSummaryWeekday;
  ownerWeeklySummaryTime?: string;
}

export interface RestaurantManagerContactInput {
  name?: string;
  phone: string;
}

export type RestaurantUpdateInput = Partial<Omit<RestaurantInput, "name">> & {
  name?: string;
};
