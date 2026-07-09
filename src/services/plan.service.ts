import { planFeatures, type PlanFeatures } from "../constants/planFeatures";
import type { PlanFeatureName, RestaurantPlan } from "../types/restaurant.types";

export class PlanValidationError extends Error {
  statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "PlanValidationError";
  }
}

export const getPlanFeatures = (plan: RestaurantPlan): PlanFeatures => {
  return planFeatures[plan];
};

export const canUseFeature = (plan: RestaurantPlan, featureName: PlanFeatureName): boolean => {
  const featureValue = planFeatures[plan][featureName];
  return typeof featureValue === "boolean" ? featureValue : featureValue > 0;
};

export const validateManagerLimit = (
  plan: RestaurantPlan,
  managerPhones: string[] = []
): void => {
  const maxStaffNumbers = planFeatures[plan].maxStaffNumbers;

  if (managerPhones.length > maxStaffNumbers) {
    throw new PlanValidationError(
      `${plan} plan allows up to ${maxStaffNumbers} manager phone number(s)`
    );
  }
};
