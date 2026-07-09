import type { RestaurantPlan } from "../types/restaurant.types";

export interface PlanFeatures {
  maxMenuItems: number;
  maxStaffNumbers: number;
  autoFollowUp: boolean;
  receiptPdf: boolean;
  foodImages: boolean;
  dailyReport: boolean;
  promotions: boolean;
  scheduledPromos: boolean;
  analytics: boolean;
  advancedReports: boolean;
}

export const planFeatures: Record<RestaurantPlan, PlanFeatures> = {
  starter: {
    maxMenuItems: 30,
    maxStaffNumbers: 1,
    autoFollowUp: true,
    receiptPdf: true,
    foodImages: false,
    dailyReport: false,
    promotions: false,
    scheduledPromos: false,
    analytics: false,
    advancedReports: false
  },
  growth: {
    maxMenuItems: 100,
    maxStaffNumbers: 3,
    autoFollowUp: true,
    receiptPdf: true,
    foodImages: true,
    dailyReport: true,
    promotions: true,
    scheduledPromos: false,
    analytics: false,
    advancedReports: false
  },
  premium: {
    maxMenuItems: 500,
    maxStaffNumbers: 10,
    autoFollowUp: true,
    receiptPdf: true,
    foodImages: true,
    dailyReport: true,
    promotions: true,
    scheduledPromos: true,
    analytics: true,
    advancedReports: true
  }
};
