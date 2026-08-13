import { Types } from "mongoose";
import {
  CustomerProfile,
  type ICommonDeliveryAddress,
  type ICustomerProfileDocument,
  type IFrequentlyOrderedItem
} from "../models/customerProfile.model";
import {
  Order,
  type IOrderDocument,
  type IOrderItem,
  type OrderStatus,
  type OrderType
} from "../models/order.model";
import { BadRequestError } from "../utils/httpErrors";
import { normalizeGhanaPhone } from "../utils/phone.util";

export const MAX_FREQUENTLY_ORDERED_ITEMS = 10;
export const MAX_COMMON_DELIVERY_ADDRESSES = 10;

type CompletedOrderProfileSource = {
  status: OrderStatus;
  customerName?: string;
  items: IOrderItem[];
  total: number;
  orderType: OrderType;
  deliveryAddress?: string;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

export interface CompletedOrderProfileStats {
  customerName?: string;
  orderCount: number;
  lastOrderAt: Date;
  averageOrderValue: number;
  frequentlyOrderedItems: IFrequentlyOrderedItem[];
  preferredOrderType: OrderType;
  commonDeliveryAddresses: ICommonDeliveryAddress[];
}

export interface ConfirmedCustomerPreferencesInput {
  confirmed: true;
  customerName?: string;
  preferredOrderType?: OrderType;
  dietaryPreferences?: string[];
  spicePreference?: string | null;
  marketingConsent?: boolean;
  isOptedOut?: boolean;
}

export interface CustomerProfileStatistics {
  totalCustomers: number;
  customersWithCompletedOrders: number;
  returningCustomers: number;
  marketingEligibleCustomers: number;
  marketingNotOptedInCustomers: number;
  marketingOptedOutCustomers: number;
  marketingConsentInvitedCustomers: number;
  marketingConsentAcceptedCustomers: number;
  marketingConsentDeclinedCustomers: number;
  marketingConsentAwaitingResponseCustomers: number;
  marketingConsentNotAskedCustomers: number;
}

const normalizeDisplayText = (value: string): string => {
  return value.trim().replace(/\s+/g, " ");
};

const normalizeComparableText = (value: string): string => {
  return normalizeDisplayText(value).toLowerCase();
};

const genericCustomerNames = new Set([
  "customer",
  "user",
  "guest",
  "unknown",
  "n/a"
]);

const getOrderCompletionDate = (
  order: CompletedOrderProfileSource
): Date => {
  return order.completedAt ?? order.updatedAt ?? order.createdAt;
};

const roundCurrency = (value: number): number => {
  return Math.round((value + Number.EPSILON) * 100) / 100;
};

export const buildCompletedOrderProfileStats = (
  orders: readonly CompletedOrderProfileSource[]
): CompletedOrderProfileStats | null => {
  const completedOrders = orders
    .filter((order) => order.status === "completed")
    .sort(
      (left, right) =>
        getOrderCompletionDate(right).getTime() -
        getOrderCompletionDate(left).getTime()
    );

  if (completedOrders.length === 0) {
    return null;
  }

  const itemAggregates = new Map<
    string,
    IFrequentlyOrderedItem & { seenInOrder: Set<number> }
  >();
  const addressAggregates = new Map<string, ICommonDeliveryAddress>();
  const orderTypeCounts: Record<OrderType, number> = {
    pickup: 0,
    delivery: 0
  };
  let totalOrderValue = 0;

  completedOrders.forEach((order, orderIndex) => {
    const completedAt = getOrderCompletionDate(order);
    totalOrderValue += order.total;
    orderTypeCounts[order.orderType] += 1;

    for (const item of order.items) {
      const itemKey = String(item.menuItemId);
      const existing = itemAggregates.get(itemKey);

      if (!existing) {
        itemAggregates.set(itemKey, {
          menuItemId: item.menuItemId,
          name: normalizeDisplayText(item.name),
          orderCount: 1,
          totalQuantity: item.quantity,
          lastOrderedAt: completedAt,
          seenInOrder: new Set([orderIndex])
        });
        continue;
      }

      existing.totalQuantity += item.quantity;

      if (!existing.seenInOrder.has(orderIndex)) {
        existing.orderCount += 1;
        existing.seenInOrder.add(orderIndex);
      }

      if (completedAt > existing.lastOrderedAt) {
        existing.name = normalizeDisplayText(item.name);
        existing.lastOrderedAt = completedAt;
      }
    }

    if (order.orderType === "delivery" && order.deliveryAddress?.trim()) {
      const address = normalizeDisplayText(order.deliveryAddress);
      const addressKey = normalizeComparableText(address);
      const existing = addressAggregates.get(addressKey);

      if (!existing) {
        addressAggregates.set(addressKey, {
          address,
          orderCount: 1,
          lastUsedAt: completedAt
        });
      } else {
        existing.orderCount += 1;

        if (completedAt > existing.lastUsedAt) {
          existing.address = address;
          existing.lastUsedAt = completedAt;
        }
      }
    }
  });

  const latestOrder = completedOrders[0];
  const latestCustomerName = completedOrders
    .map((order) => order.customerName?.trim())
    .find((name): name is string => Boolean(name));
  const preferredOrderType =
    orderTypeCounts.delivery === orderTypeCounts.pickup
      ? latestOrder.orderType
      : orderTypeCounts.delivery > orderTypeCounts.pickup
        ? "delivery"
        : "pickup";
  const frequentlyOrderedItems = Array.from(itemAggregates.values())
    .sort((left, right) => {
      return (
        right.totalQuantity - left.totalQuantity ||
        right.orderCount - left.orderCount ||
        right.lastOrderedAt.getTime() - left.lastOrderedAt.getTime() ||
        left.name.localeCompare(right.name)
      );
    })
    .slice(0, MAX_FREQUENTLY_ORDERED_ITEMS)
    .map(({ seenInOrder: _seenInOrder, ...item }) => item);
  const commonDeliveryAddresses = Array.from(addressAggregates.values())
    .sort((left, right) => {
      return (
        right.orderCount - left.orderCount ||
        right.lastUsedAt.getTime() - left.lastUsedAt.getTime() ||
        left.address.localeCompare(right.address)
      );
    })
    .slice(0, MAX_COMMON_DELIVERY_ADDRESSES);

  return {
    customerName: latestCustomerName
      ? normalizeDisplayText(latestCustomerName)
      : undefined,
    orderCount: completedOrders.length,
    lastOrderAt: getOrderCompletionDate(latestOrder),
    averageOrderValue: roundCurrency(
      totalOrderValue / completedOrders.length
    ),
    frequentlyOrderedItems,
    preferredOrderType,
    commonDeliveryAddresses
  };
};

const ensureValidRestaurantId = (restaurantId: string): void => {
  if (!Types.ObjectId.isValid(restaurantId)) {
    throw new BadRequestError("Invalid restaurantId");
  }
};

const ensureCustomerPhone = (customerPhone: string): string => {
  const normalizedPhone = normalizeGhanaPhone(customerPhone);

  if (normalizedPhone.length < 7) {
    throw new BadRequestError("Invalid customerPhone");
  }

  return normalizedPhone;
};

export const rememberConfirmedCustomerName = async (
  restaurantId: string,
  customerPhone: string,
  customerName: string
): Promise<ICustomerProfileDocument> => {
  ensureValidRestaurantId(restaurantId);
  const normalizedPhone = ensureCustomerPhone(customerPhone);
  const normalizedName = normalizeDisplayText(customerName);

  if (
    !normalizedName ||
    genericCustomerNames.has(normalizedName.toLowerCase())
  ) {
    throw new BadRequestError("A valid customer name is required");
  }

  const existingProfile = await CustomerProfile.findOne({
    restaurantId,
    customerPhone: normalizedPhone
  });

  if (existingProfile?.customerNameSource === "customer_confirmed") {
    return existingProfile;
  }

  if (existingProfile) {
    existingProfile.customerName = normalizedName;
    existingProfile.customerNameSource = "customer_confirmed";
    return existingProfile.save();
  }

  try {
    return await CustomerProfile.create({
      restaurantId,
      customerPhone: normalizedPhone,
      customerName: normalizedName,
      customerNameSource: "customer_confirmed"
    });
  } catch (error) {
    const isDuplicateKey =
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: number }).code === 11000;

    if (!isDuplicateKey) {
      throw error;
    }

    const concurrentlyCreatedProfile = await CustomerProfile.findOne({
      restaurantId,
      customerPhone: normalizedPhone
    });

    if (!concurrentlyCreatedProfile) {
      throw error;
    }

    if (
      concurrentlyCreatedProfile.customerNameSource === "customer_confirmed"
    ) {
      return concurrentlyCreatedProfile;
    }

    concurrentlyCreatedProfile.customerName = normalizedName;
    concurrentlyCreatedProfile.customerNameSource = "customer_confirmed";
    return concurrentlyCreatedProfile.save();
  }
};

export const getEquivalentCustomerPhones = (customerPhone: string): string[] => {
  const normalizedPhone = ensureCustomerPhone(customerPhone);
  const equivalentPhones = new Set([
    normalizedPhone,
    customerPhone.trim()
  ]);

  if (normalizedPhone.startsWith("+233") && normalizedPhone.length === 13) {
    equivalentPhones.add(normalizedPhone.slice(1));
    equivalentPhones.add(`0${normalizedPhone.slice(4)}`);
  }

  return Array.from(equivalentPhones).filter(Boolean);
};

export const refreshCustomerProfileFromCompletedOrders = async (
  restaurantId: string,
  customerPhone: string
): Promise<ICustomerProfileDocument | null> => {
  ensureValidRestaurantId(restaurantId);
  const normalizedPhone = ensureCustomerPhone(customerPhone);
  const completedOrders = await Order.find({
    restaurantId,
    customerPhone: {
      $in: getEquivalentCustomerPhones(customerPhone)
    },
    status: "completed"
  }).sort({ completedAt: -1, updatedAt: -1, createdAt: -1 });
  const stats = buildCompletedOrderProfileStats(completedOrders);

  if (!stats) {
    return null;
  }

  const existingProfile = await CustomerProfile.findOne({
    restaurantId,
    customerPhone: normalizedPhone
  }).select("customerNameSource preferredOrderTypeSource");
  const orderDerivedFields: Record<string, unknown> = {
    orderCount: stats.orderCount,
    lastOrderAt: stats.lastOrderAt,
    averageOrderValue: stats.averageOrderValue,
    frequentlyOrderedItems: stats.frequentlyOrderedItems,
    commonDeliveryAddresses: stats.commonDeliveryAddresses
  };

  if (existingProfile?.customerNameSource !== "customer_confirmed") {
    orderDerivedFields.customerName = stats.customerName;
    orderDerivedFields.customerNameSource = "completed_order";
  }

  if (
    existingProfile?.preferredOrderTypeSource !== "customer_confirmed"
  ) {
    orderDerivedFields.preferredOrderType = stats.preferredOrderType;
    orderDerivedFields.preferredOrderTypeSource = "completed_order";
  }

  return CustomerProfile.findOneAndUpdate(
    {
      restaurantId,
      customerPhone: normalizedPhone
    },
    {
      $set: orderDerivedFields,
      $setOnInsert: {
        restaurantId,
        customerPhone: normalizedPhone
      }
    },
    {
      new: true,
      upsert: true,
      runValidators: true,
      setDefaultsOnInsert: true
    }
  );
};

export const updateCustomerProfileFromCompletedOrder = async (
  order: IOrderDocument
): Promise<ICustomerProfileDocument | null> => {
  if (order.status !== "completed") {
    return null;
  }

  return refreshCustomerProfileFromCompletedOrders(
    String(order.restaurantId),
    order.customerPhone
  );
};

export const updateConfirmedCustomerPreferences = async (
  restaurantId: string,
  customerPhone: string,
  input: ConfirmedCustomerPreferencesInput
): Promise<ICustomerProfileDocument> => {
  ensureValidRestaurantId(restaurantId);
  const normalizedPhone = ensureCustomerPhone(customerPhone);

  if (input.confirmed !== true) {
    throw new BadRequestError(
      "Customer preferences must be explicitly confirmed"
    );
  }

  if (input.marketingConsent === true && input.isOptedOut === true) {
    throw new BadRequestError(
      "Marketing consent and opt-out status cannot both be true"
    );
  }

  const preferenceFields: Record<string, unknown> = {};
  const preferenceUnsetFields: Record<string, ""> = {};

  if (input.customerName !== undefined) {
    const customerName = normalizeDisplayText(input.customerName);

    if (!customerName) {
      throw new BadRequestError("Customer name cannot be empty");
    }

    preferenceFields.customerName = customerName;
    preferenceFields.customerNameSource = "customer_confirmed";
  }

  if (input.preferredOrderType !== undefined) {
    preferenceFields.preferredOrderType = input.preferredOrderType;
    preferenceFields.preferredOrderTypeSource = "customer_confirmed";
  }

  if (input.dietaryPreferences !== undefined) {
    const preferencesByKey = new Map<string, string>();

    for (const preference of input.dietaryPreferences) {
      const normalizedPreference = normalizeDisplayText(preference);
      const preferenceKey = normalizeComparableText(normalizedPreference);

      if (normalizedPreference && !preferencesByKey.has(preferenceKey)) {
        preferencesByKey.set(preferenceKey, normalizedPreference);
      }
    }

    preferenceFields.dietaryPreferences = Array.from(
      preferencesByKey.values()
    );
  }

  if (input.spicePreference !== undefined) {
    preferenceFields.spicePreference =
      input.spicePreference === null
        ? null
        : normalizeDisplayText(input.spicePreference);
  }

  if (input.marketingConsent !== undefined) {
    const marketingPreferenceUpdatedAt = new Date();
    preferenceFields.marketingConsent = input.marketingConsent;
    preferenceFields.marketingPreferenceUpdatedAt =
      marketingPreferenceUpdatedAt;
    preferenceFields.marketingConsentSource = "admin_recorded";

    if (input.marketingConsent) {
      preferenceFields.isOptedOut = false;
      preferenceFields.marketingConsentAt = marketingPreferenceUpdatedAt;
      preferenceUnsetFields.optedOutAt = "";
      preferenceUnsetFields.optedOutSource = "";
    }
  }

  if (input.isOptedOut !== undefined) {
    const marketingPreferenceUpdatedAt = new Date();
    preferenceFields.isOptedOut = input.isOptedOut;
    preferenceFields.marketingPreferenceUpdatedAt =
      marketingPreferenceUpdatedAt;

    if (input.isOptedOut) {
      preferenceFields.marketingConsent = false;
      preferenceFields.optedOutAt = marketingPreferenceUpdatedAt;
      preferenceFields.optedOutSource = "admin_recorded";
    } else {
      preferenceUnsetFields.optedOutAt = "";
      preferenceUnsetFields.optedOutSource = "";
    }
  }

  if (Object.keys(preferenceFields).length === 0) {
    throw new BadRequestError(
      "At least one confirmed customer preference is required"
    );
  }

  preferenceFields.preferencesConfirmedAt = new Date();

  const profile = await CustomerProfile.findOneAndUpdate(
    {
      restaurantId,
      customerPhone: normalizedPhone
    },
    {
      $set: preferenceFields,
      ...(Object.keys(preferenceUnsetFields).length > 0
        ? {
            $unset: preferenceUnsetFields
          }
        : {}),
      $setOnInsert: {
        restaurantId,
        customerPhone: normalizedPhone
      }
    },
    {
      new: true,
      upsert: true,
      runValidators: true,
      setDefaultsOnInsert: true
    }
  );

  if (!profile) {
    throw new Error("Customer profile could not be updated");
  }

  return profile;
};

export const getCustomerProfile = async (
  restaurantId: string,
  customerPhone: string
): Promise<ICustomerProfileDocument | null> => {
  ensureValidRestaurantId(restaurantId);

  return CustomerProfile.findOne({
    restaurantId,
    customerPhone: ensureCustomerPhone(customerPhone)
  });
};

export const getCustomerProfileStatistics = async (
  restaurantId: string
): Promise<CustomerProfileStatistics> => {
  ensureValidRestaurantId(restaurantId);
  const scope = { restaurantId };
  const [
    totalCustomers,
    customersWithCompletedOrders,
    returningCustomers,
    marketingEligibleCustomers,
    marketingOptedOutCustomers,
    marketingConsentInvitedCustomers,
    marketingConsentAcceptedCustomers,
    marketingConsentDeclinedCustomers
  ] = await Promise.all([
    CustomerProfile.countDocuments(scope),
    CustomerProfile.countDocuments({
      ...scope,
      orderCount: { $gte: 1 }
    }),
    CustomerProfile.countDocuments({
      ...scope,
      orderCount: { $gte: 2 }
    }),
    CustomerProfile.countDocuments({
      ...scope,
      marketingConsent: true,
      isOptedOut: { $ne: true }
    }),
    CustomerProfile.countDocuments({
      ...scope,
      isOptedOut: true
    }),
    CustomerProfile.countDocuments({
      ...scope,
      marketingConsentPromptedAt: { $exists: true }
    }),
    CustomerProfile.countDocuments({
      ...scope,
      marketingConsentPromptResponse: "opt_in"
    }),
    CustomerProfile.countDocuments({
      ...scope,
      marketingConsentPromptResponse: "opt_out"
    })
  ]);

  const marketingConsentAwaitingResponseCustomers = Math.max(
    0,
    marketingConsentInvitedCustomers -
      marketingConsentAcceptedCustomers -
      marketingConsentDeclinedCustomers
  );

  return {
    totalCustomers,
    customersWithCompletedOrders,
    returningCustomers,
    marketingEligibleCustomers,
    marketingNotOptedInCustomers: Math.max(
      0,
      totalCustomers -
        marketingEligibleCustomers -
        marketingOptedOutCustomers
    ),
    marketingOptedOutCustomers,
    marketingConsentInvitedCustomers,
    marketingConsentAcceptedCustomers,
    marketingConsentDeclinedCustomers,
    marketingConsentAwaitingResponseCustomers,
    marketingConsentNotAskedCustomers: Math.max(
      0,
      totalCustomers - marketingConsentInvitedCustomers
    )
  };
};
