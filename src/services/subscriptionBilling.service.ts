import { Types } from "mongoose";
import { Restaurant, type IRestaurantDocument } from "../models/Restaurant";
import { BadRequestError, NotFoundError } from "../utils/httpErrors";

const BILLING_RECONCILIATION_INTERVAL_MS = 24 * 60 * 60 * 1000;
let schedulerStarted = false;
let schedulerBusy = false;
let schedulerPassLogged = false;

export interface SubscriptionPaymentInput {
  renewalDateOverride?: Date;
}

export interface SubscriptionPaymentDependencies {
  loadRestaurant?: (restaurantId: string) => Promise<IRestaurantDocument | null>;
}

type ReconciliationRestaurant = Pick<
  IRestaurantDocument,
  "_id" | "billingStatus" | "subscriptionRenewalDate"
>;

export interface SubscriptionBillingReconciliationDependencies {
  loadRestaurants?: () => Promise<ReconciliationRestaurant[]>;
  markPastDue?: (restaurant: ReconciliationRestaurant) => Promise<boolean>;
  logError?: (message: string, context: Record<string, unknown>) => void;
}

export interface SubscriptionBillingReconciliationResult {
  restaurantsChecked: number;
  markedPastDue: number;
  errors: number;
}

const normalizeCalendarDate = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

export const addCalendarMonthClamped = (date: Date): Date => {
  const targetMonthStart = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
  );
  const lastDayOfTargetMonth = new Date(
    Date.UTC(
      targetMonthStart.getUTCFullYear(),
      targetMonthStart.getUTCMonth() + 1,
      0
    )
  ).getUTCDate();

  return new Date(
    Date.UTC(
      targetMonthStart.getUTCFullYear(),
      targetMonthStart.getUTCMonth(),
      Math.min(date.getUTCDate(), lastDayOfTargetMonth)
    )
  );
};

export const isRenewalDue = (renewalDate: Date, now = new Date()): boolean =>
  normalizeCalendarDate(renewalDate).getTime() <= normalizeCalendarDate(now).getTime();

const loadRestaurantForBilling = async (
  restaurantId: string
): Promise<IRestaurantDocument | null> => {
  if (!Types.ObjectId.isValid(restaurantId)) {
    throw new BadRequestError("Invalid restaurantId");
  }

  return Restaurant.findById(restaurantId);
};

export const recordSubscriptionPayment = async (
  restaurantId: string,
  input: SubscriptionPaymentInput = {},
  now = new Date(),
  dependencies: SubscriptionPaymentDependencies = {}
): Promise<IRestaurantDocument> => {
  const loadRestaurant = dependencies.loadRestaurant ?? loadRestaurantForBilling;
  const restaurant = await loadRestaurant(restaurantId);

  if (!restaurant) {
    throw new NotFoundError("Restaurant not found");
  }

  if (
    typeof restaurant.subscriptionAmount !== "number" ||
    !Number.isFinite(restaurant.subscriptionAmount) ||
    restaurant.subscriptionAmount <= 0
  ) {
    throw new BadRequestError(
      "Configure the monthly subscription amount before recording payment."
    );
  }

  restaurant.subscriptionLastPaidAt = new Date(now);
  restaurant.billingStatus = "active";
  restaurant.subscriptionRenewalDate = input.renewalDateOverride
    ? normalizeCalendarDate(input.renewalDateOverride)
    : addCalendarMonthClamped(now);

  return restaurant.save();
};

const loadActiveSubscriptions = async (): Promise<ReconciliationRestaurant[]> => {
  return Restaurant.find({
    billingStatus: "active",
    subscriptionRenewalDate: { $exists: true, $ne: null }
  }).select("_id billingStatus subscriptionRenewalDate");
};

const markRestaurantPastDue = async (
  restaurant: ReconciliationRestaurant
): Promise<boolean> => {
  const result = await Restaurant.updateOne(
    {
      _id: restaurant._id,
      billingStatus: "active",
      subscriptionRenewalDate: restaurant.subscriptionRenewalDate
    },
    { $set: { billingStatus: "past_due" } }
  );

  return result.modifiedCount > 0;
};

export const runSubscriptionBillingReconciliation = async (
  now = new Date(),
  dependencies: SubscriptionBillingReconciliationDependencies = {}
): Promise<SubscriptionBillingReconciliationResult> => {
  const loadRestaurants = dependencies.loadRestaurants ?? loadActiveSubscriptions;
  const markPastDue = dependencies.markPastDue ?? markRestaurantPastDue;
  const logError =
    dependencies.logError ??
    ((message: string, context: Record<string, unknown>) =>
      console.error(message, context));
  const restaurants = await loadRestaurants();
  const result: SubscriptionBillingReconciliationResult = {
    restaurantsChecked: restaurants.length,
    markedPastDue: 0,
    errors: 0
  };

  for (const restaurant of restaurants) {
    if (
      restaurant.billingStatus !== "active" ||
      !restaurant.subscriptionRenewalDate ||
      !isRenewalDue(restaurant.subscriptionRenewalDate, now)
    ) {
      continue;
    }

    try {
      if (await markPastDue(restaurant)) {
        result.markedPastDue += 1;
      }
    } catch (error) {
      result.errors += 1;
      logError("Subscription billing reconciliation failed", {
        restaurantId: String(restaurant._id),
        error:
          error instanceof Error
            ? error.message
            : "Unknown subscription billing reconciliation error"
      });
    }
  }

  return result;
};

export const startSubscriptionBillingScheduler = (): void => {
  if (schedulerStarted) {
    return;
  }

  schedulerStarted = true;
  console.log("[subscriptionBilling] Daily reconciliation scheduler started");

  const runPass = (): void => {
    if (schedulerBusy) {
      return;
    }

    schedulerBusy = true;
    void runSubscriptionBillingReconciliation()
      .then((result) => {
        if (!schedulerPassLogged || result.markedPastDue > 0 || result.errors > 0) {
          console.info("[subscriptionBilling] Reconciliation pass", result);
          schedulerPassLogged = true;
        }
      })
      .catch((error) => {
        console.error("Subscription billing scheduler pass failed", {
          error:
            error instanceof Error
              ? error.message
              : "Unknown subscription billing scheduler error"
        });
      })
      .finally(() => {
        schedulerBusy = false;
      });
  };

  runPass();
  const timer = setInterval(runPass, BILLING_RECONCILIATION_INTERVAL_MS);
  timer.unref?.();
};
