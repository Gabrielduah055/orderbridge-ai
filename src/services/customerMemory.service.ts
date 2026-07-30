import type { ICustomerProfileDocument } from "../models/customerProfile.model";
import { CustomerProfile } from "../models/customerProfile.model";
import type {
  IOrderDocument,
  IOrderItem,
  OrderType
} from "../models/order.model";
import { Order } from "../models/order.model";
import { normalizeGhanaPhone } from "../utils/phone.util";
import { getEquivalentCustomerPhones } from "./customerProfile.service";

export const CUSTOMER_MEMORY_RECENT_ORDER_LIMIT = 3;
export const CUSTOMER_MEMORY_RECENT_ORDER_ITEM_LIMIT = 4;
export const CUSTOMER_MEMORY_FREQUENT_ITEM_LIMIT = 5;
export const CUSTOMER_MEMORY_FOOD_PREFERENCE_LIMIT = 5;

const MAX_MEMORY_NAME_LENGTH = 80;
const MAX_MEMORY_ITEM_NAME_LENGTH = 80;
const MAX_MEMORY_PREFERENCE_LENGTH = 80;

export type CustomerMarketingConsent =
  | "granted"
  | "declined"
  | "opted_out";

export interface CustomerMemoryRecentOrder {
  orderedOn: string;
  orderType: OrderType;
  items: string[];
}

export interface CustomerMemoryFoodPreferences {
  dietary?: string[];
  spice?: string;
}

export interface CustomerMemorySummary {
  name?: string;
  completedOrderCount?: number;
  recentOrders?: CustomerMemoryRecentOrder[];
  frequentItems?: string[];
  preferredOrderType?: OrderType;
  confirmedFoodPreferences?: CustomerMemoryFoodPreferences;
  marketingConsent?: CustomerMarketingConsent;
}

type CustomerMemoryProfileSource = Pick<
  ICustomerProfileDocument,
  | "customerName"
  | "orderCount"
  | "frequentlyOrderedItems"
  | "preferredOrderType"
  | "dietaryPreferences"
  | "spicePreference"
  | "marketingConsent"
  | "isOptedOut"
  | "preferencesConfirmedAt"
>;

type CustomerMemoryOrderSource = Pick<
  IOrderDocument,
  "items" | "orderType" | "completedAt" | "createdAt" | "updatedAt"
>;

const compactText = (value: string, maximumLength: number): string => {
  return value.trim().replace(/\s+/g, " ").slice(0, maximumLength);
};

const getOrderDate = (order: CustomerMemoryOrderSource): Date => {
  return order.completedAt ?? order.updatedAt ?? order.createdAt;
};

const buildRecentOrderItems = (items: readonly IOrderItem[]): string[] => {
  const visibleItems = items
    .slice(0, CUSTOMER_MEMORY_RECENT_ORDER_ITEM_LIMIT)
    .map((item) => {
      const name = compactText(item.name, MAX_MEMORY_ITEM_NAME_LENGTH);
      return `${item.quantity} x ${name}`;
    });
  const hiddenItemCount =
    items.length - CUSTOMER_MEMORY_RECENT_ORDER_ITEM_LIMIT;

  if (hiddenItemCount > 0) {
    visibleItems.push(
      `+${hiddenItemCount} more item${hiddenItemCount === 1 ? "" : "s"}`
    );
  }

  return visibleItems;
};

const getMarketingConsent = (
  profile: CustomerMemoryProfileSource
): CustomerMarketingConsent | undefined => {
  if (!profile.preferencesConfirmedAt) {
    return undefined;
  }

  if (profile.isOptedOut === true) {
    return "opted_out";
  }

  if (profile.marketingConsent === true) {
    return "granted";
  }

  if (profile.marketingConsent === false) {
    return "declined";
  }

  return undefined;
};

const getConfirmedFoodPreferences = (
  profile: CustomerMemoryProfileSource
): CustomerMemoryFoodPreferences | undefined => {
  if (!profile.preferencesConfirmedAt) {
    return undefined;
  }

  const dietary = (profile.dietaryPreferences ?? [])
    .slice(0, CUSTOMER_MEMORY_FOOD_PREFERENCE_LIMIT)
    .map((preference) =>
      compactText(preference, MAX_MEMORY_PREFERENCE_LENGTH)
    )
    .filter(Boolean);
  const spice = profile.spicePreference?.trim()
    ? compactText(
        profile.spicePreference,
        MAX_MEMORY_PREFERENCE_LENGTH
      )
    : undefined;

  if (dietary.length === 0 && !spice) {
    return undefined;
  }

  return {
    ...(dietary.length > 0 ? { dietary } : {}),
    ...(spice ? { spice } : {})
  };
};

export const buildCustomerMemorySummary = (
  profile: CustomerMemoryProfileSource,
  recentOrders: readonly CustomerMemoryOrderSource[]
): CustomerMemorySummary | null => {
  const name = profile.customerName?.trim()
    ? compactText(profile.customerName, MAX_MEMORY_NAME_LENGTH)
    : undefined;
  const orders = recentOrders
    .slice(0, CUSTOMER_MEMORY_RECENT_ORDER_LIMIT)
    .map((order) => ({
      orderedOn: getOrderDate(order).toISOString().slice(0, 10),
      orderType: order.orderType,
      items: buildRecentOrderItems(order.items)
    }));
  const frequentItems = (profile.frequentlyOrderedItems ?? [])
    .slice(0, CUSTOMER_MEMORY_FREQUENT_ITEM_LIMIT)
    .map((item) => {
      const itemName = compactText(
        item.name,
        MAX_MEMORY_ITEM_NAME_LENGTH
      );
      return `${itemName} (${item.orderCount} completed order${
        item.orderCount === 1 ? "" : "s"
      })`;
    });
  const confirmedFoodPreferences =
    getConfirmedFoodPreferences(profile);
  const marketingConsent = getMarketingConsent(profile);
  const summary: CustomerMemorySummary = {
    ...(name ? { name } : {}),
    ...(profile.orderCount > 0
      ? { completedOrderCount: profile.orderCount }
      : {}),
    ...(orders.length > 0 ? { recentOrders: orders } : {}),
    ...(frequentItems.length > 0 ? { frequentItems } : {}),
    ...(profile.preferredOrderType
      ? { preferredOrderType: profile.preferredOrderType }
      : {}),
    ...(confirmedFoodPreferences
      ? { confirmedFoodPreferences }
      : {}),
    ...(marketingConsent ? { marketingConsent } : {})
  };

  return Object.keys(summary).length > 0 ? summary : null;
};

export const loadCustomerMemorySummary = async (
  restaurantId: string,
  customerPhone: string
): Promise<CustomerMemorySummary | null> => {
  const normalizedPhone = normalizeGhanaPhone(customerPhone);
  const profile = await CustomerProfile.findOne({
    restaurantId,
    customerPhone: normalizedPhone
  }).select(
    [
      "customerName",
      "orderCount",
      "frequentlyOrderedItems.name",
      "frequentlyOrderedItems.orderCount",
      "preferredOrderType",
      "dietaryPreferences",
      "spicePreference",
      "marketingConsent",
      "isOptedOut",
      "preferencesConfirmedAt"
    ].join(" ")
  );

  if (!profile) {
    return null;
  }

  const recentOrders = await Order.find({
    restaurantId,
    customerPhone: {
      $in: getEquivalentCustomerPhones(customerPhone)
    },
    status: "completed"
  })
    .select(
      "items.name items.quantity orderType completedAt createdAt updatedAt"
    )
    .sort({ completedAt: -1, updatedAt: -1, createdAt: -1 })
    .limit(CUSTOMER_MEMORY_RECENT_ORDER_LIMIT);

  return buildCustomerMemorySummary(profile, recentOrders);
};
