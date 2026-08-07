import mongoose from "mongoose";
import { Restaurant } from "../models/Restaurant";
import { getSafeErrorMessage } from "../utils/error.util";

export const restaurantSchedulerConfigDefaults = {
  timezone: "Africa/Accra",
  followUpEnabled: true,
  followUpDelayMinutes: 5,
  ownerDailySummaryEnabled: true,
  ownerDailySummaryTime: "08:00",
  ownerWeeklySummaryEnabled: true,
  ownerWeeklySummaryDay: "monday",
  ownerWeeklySummaryTime: "08:00",
  postDeliveryFollowUpEnabled: true,
  postDeliveryFollowUpDelayMinutes: 45
} as const;

export type RestaurantSchedulerConfigField =
  keyof typeof restaurantSchedulerConfigDefaults;

export interface RestaurantSchedulerConfigRecord {
  _id: unknown;
  name?: unknown;
  [key: string]: unknown;
}

export interface RestaurantSchedulerBackfillDependencies {
  loadRestaurants?: () => Promise<RestaurantSchedulerConfigRecord[]>;
  setFieldIfMissing?: (
    restaurantId: unknown,
    field: RestaurantSchedulerConfigField,
    value: (typeof restaurantSchedulerConfigDefaults)[RestaurantSchedulerConfigField]
  ) => Promise<boolean>;
  log?: (message: string) => void;
}

export interface RestaurantSchedulerBackfillSummary {
  restaurantsChecked: number;
  restaurantsNeedingUpdate: number;
  restaurantsUpdated: number;
}

const schedulerConfigFields = Object.keys(
  restaurantSchedulerConfigDefaults
) as RestaurantSchedulerConfigField[];

export const getMissingRestaurantSchedulerConfig = (
  restaurant: RestaurantSchedulerConfigRecord
): Partial<typeof restaurantSchedulerConfigDefaults> => {
  const missing: Partial<typeof restaurantSchedulerConfigDefaults> = {};

  for (const field of schedulerConfigFields) {
    if (!Object.prototype.hasOwnProperty.call(restaurant, field)) {
      Object.assign(missing, {
        [field]: restaurantSchedulerConfigDefaults[field]
      });
    }
  }

  return missing;
};

const loadRestaurantRecords = async (): Promise<
  RestaurantSchedulerConfigRecord[]
> => {
  const projection = Object.fromEntries([
    ["name", 1],
    ...schedulerConfigFields.map((field) => [field, 1])
  ]);

  return Restaurant.collection
    .find({}, { projection })
    .toArray() as Promise<RestaurantSchedulerConfigRecord[]>;
};

const setRestaurantFieldIfMissing = async (
  restaurantId: unknown,
  field: RestaurantSchedulerConfigField,
  value: (typeof restaurantSchedulerConfigDefaults)[RestaurantSchedulerConfigField]
): Promise<boolean> => {
  const result = await Restaurant.updateOne(
    {
      _id: restaurantId,
      [field]: { $exists: false }
    },
    {
      $set: { [field]: value }
    }
  );

  return result.modifiedCount === 1;
};

export const backfillRestaurantSchedulerConfig = async (
  applyChanges = false,
  dependencies: RestaurantSchedulerBackfillDependencies = {}
): Promise<RestaurantSchedulerBackfillSummary> => {
  const loadRestaurants = dependencies.loadRestaurants ?? loadRestaurantRecords;
  const setFieldIfMissing =
    dependencies.setFieldIfMissing ?? setRestaurantFieldIfMissing;
  const log = dependencies.log ?? console.log;
  const restaurants = await loadRestaurants();
  const summary: RestaurantSchedulerBackfillSummary = {
    restaurantsChecked: restaurants.length,
    restaurantsNeedingUpdate: 0,
    restaurantsUpdated: 0
  };

  for (const restaurant of restaurants) {
    const missing = getMissingRestaurantSchedulerConfig(restaurant);
    const fields = Object.keys(missing) as RestaurantSchedulerConfigField[];

    if (fields.length === 0) {
      continue;
    }

    summary.restaurantsNeedingUpdate += 1;
    log(
      JSON.stringify({
        restaurantId: String(restaurant._id),
        restaurantName:
          typeof restaurant.name === "string" ? restaurant.name : "(unnamed)",
        fieldsBeingAdded: fields
      })
    );

    if (!applyChanges) {
      continue;
    }

    let restaurantUpdated = false;

    for (const field of fields) {
      const updated = await setFieldIfMissing(
        restaurant._id,
        field,
        restaurantSchedulerConfigDefaults[field]
      );
      restaurantUpdated ||= updated;
    }

    if (restaurantUpdated) {
      summary.restaurantsUpdated += 1;
    }
  }

  log(
    JSON.stringify({
      mode: applyChanges ? "apply" : "dry-run",
      ...summary
    })
  );

  return summary;
};

const main = async (): Promise<void> => {
  const applyChanges = process.argv.includes("--apply");
  const { connectDb } = await import("../config/db");

  await connectDb({ ensureIndexes: false, autoIndex: false });

  try {
    await backfillRestaurantSchedulerConfig(applyChanges);
  } finally {
    await mongoose.disconnect();
  }
};

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error("Restaurant scheduler config backfill failed", {
      error: getSafeErrorMessage(error, "Unknown restaurant config backfill error")
    });
    process.exitCode = 1;
  });
}
