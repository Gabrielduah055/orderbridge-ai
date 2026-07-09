export const restaurantPlans = ["starter", "growth", "premium"] as const;
export const restaurantStatuses = ["trial", "active", "paused", "cancelled"] as const;
export const assistantTones = ["friendly", "professional", "casual", "concise", "playful"] as const;

export type RestaurantPlan = (typeof restaurantPlans)[number];
export type RestaurantStatus = (typeof restaurantStatuses)[number];
export type AssistantTone = (typeof assistantTones)[number];

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
  wasenderSessionId: string;
  wasenderApiToken?: string;
  whatsappNumber: string;
  openingHours?: string;
  pickupAddress?: string;
  deliveryEnabled?: boolean;
  deliveryAreas?: string[];
  deliveryRadiusKm?: number;
  minimumOrderValue?: number;
  allowTakeaway?: boolean;
  freeDeliveryThresholdEnabled?: boolean;
  deliveryFeeNote?: string;
  assistantTone?: AssistantTone;
  assistantPersonalitySummary?: string;
  followUpEnabled?: boolean;
  followUpDelayMinutes?: number;
}

export interface RestaurantManagerContactInput {
  name?: string;
  phone: string;
}

export type RestaurantUpdateInput = Partial<Omit<RestaurantInput, "name">> & {
  name?: string;
};
