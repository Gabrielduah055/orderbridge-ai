import mongoose from "mongoose";
import { Restaurant } from "../models/Restaurant";
import { getSafeErrorMessage } from "../utils/error.util";

export interface RestaurantTokenSelector {
  slug?: string;
  restaurantId?: string;
}

interface RestaurantTokenTarget {
  _id: unknown;
  name: string;
  wasenderSessionId?: string;
}

export interface SetRestaurantWasenderTokenDependencies {
  findRestaurants?: (
    selector: RestaurantTokenSelector
  ) => Promise<RestaurantTokenTarget[]>;
  updateToken?: (restaurantId: unknown, token: string) => Promise<boolean>;
  log?: (message: string) => void;
}

export const parseRestaurantTokenSelector = (
  args: string[]
): RestaurantTokenSelector => {
  const readArgument = (name: string): string | undefined => {
    const index = args.indexOf(name);

    if (index === -1) {
      return undefined;
    }

    const value = args[index + 1]?.trim();

    if (!value || value.startsWith("--")) {
      throw new Error(`${name} requires a value.`);
    }

    return value;
  };
  const slug = readArgument("--slug");
  const restaurantId = readArgument("--restaurant-id");

  if (Boolean(slug) === Boolean(restaurantId)) {
    throw new Error("Provide exactly one of --slug or --restaurant-id.");
  }

  return slug
    ? { slug: slug.toLowerCase() }
    : { restaurantId: restaurantId as string };
};

const findRestaurantTargets = async (
  selector: RestaurantTokenSelector
): Promise<RestaurantTokenTarget[]> => {
  if (selector.restaurantId && !mongoose.isValidObjectId(selector.restaurantId)) {
    throw new Error("--restaurant-id must be a valid MongoDB ObjectId.");
  }

  const filter = selector.slug
    ? { slug: selector.slug }
    : { _id: selector.restaurantId };

  return Restaurant.find(filter)
    .select("_id name wasenderSessionId")
    .limit(2)
    .lean<RestaurantTokenTarget[]>();
};

const updateRestaurantToken = async (
  restaurantId: unknown,
  token: string
): Promise<boolean> => {
  const result = await Restaurant.updateOne(
    { _id: restaurantId },
    { $set: { wasenderApiToken: token } }
  );

  return result.matchedCount === 1;
};

export const setRestaurantWasenderToken = async (
  selector: RestaurantTokenSelector,
  token: string | undefined,
  dependencies: SetRestaurantWasenderTokenDependencies = {}
): Promise<void> => {
  const normalizedToken = token?.trim();

  if (!normalizedToken) {
    throw new Error("RESTAURANT_WASENDER_API_TOKEN must be non-empty.");
  }

  if (Boolean(selector.slug) === Boolean(selector.restaurantId)) {
    throw new Error("Provide exactly one of --slug or --restaurant-id.");
  }

  const findRestaurants = dependencies.findRestaurants ?? findRestaurantTargets;
  const updateToken = dependencies.updateToken ?? updateRestaurantToken;
  const log = dependencies.log ?? console.log;
  const restaurants = await findRestaurants(selector);

  if (restaurants.length === 0) {
    throw new Error("Restaurant not found.");
  }

  if (restaurants.length !== 1) {
    throw new Error("Selector matched more than one restaurant.");
  }

  const restaurant = restaurants[0];

  if (!restaurant.wasenderSessionId?.trim()) {
    throw new Error("Restaurant must have a WaSender session ID before setting its API token.");
  }

  if (!(await updateToken(restaurant._id, normalizedToken))) {
    throw new Error("Restaurant token update did not match the selected restaurant.");
  }

  log(`WaSender API token configured for ${restaurant.name}.`);
};

const redactToken = (message: string, token: string | undefined): string => {
  if (!token) {
    return message;
  }

  return Array.from(new Set([token, token.trim()]))
    .filter(Boolean)
    .reduce(
      (redacted, secret) => redacted.split(secret).join("[REDACTED]"),
      message
    );
};

const main = async (): Promise<void> => {
  const selector = parseRestaurantTokenSelector(process.argv.slice(2));
  const token = process.env.RESTAURANT_WASENDER_API_TOKEN;

  if (!token?.trim()) {
    throw new Error("RESTAURANT_WASENDER_API_TOKEN must be non-empty.");
  }

  const { connectDb } = await import("../config/db");

  await connectDb({ ensureIndexes: false, autoIndex: false });

  try {
    await setRestaurantWasenderToken(selector, token);
  } finally {
    await mongoose.disconnect();
  }
};

if (require.main === module) {
  void main().catch((error: unknown) => {
    const token = process.env.RESTAURANT_WASENDER_API_TOKEN;
    const safeMessage = getSafeErrorMessage(
      error,
      "Unknown restaurant WaSender token configuration error"
    );
    console.error("Restaurant WaSender token configuration failed", {
      error: redactToken(safeMessage, token)
    });
    process.exitCode = 1;
  });
}
