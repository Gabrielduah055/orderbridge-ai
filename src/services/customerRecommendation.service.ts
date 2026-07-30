import { Types } from "mongoose";
import {
  CustomerProfile,
  type ICustomerProfileDocument
} from "../models/customerProfile.model";
import {
  MenuItem,
  type IMenuItemDocument
} from "../models/MenuItem";
import {
  Order,
  type IOrderDocument
} from "../models/order.model";
import { BadRequestError } from "../utils/httpErrors";
import { normalizeGhanaPhone } from "../utils/phone.util";
import { getEquivalentCustomerPhones } from "./customerProfile.service";

export const CUSTOMER_RECOMMENDATION_RECENT_ORDER_LIMIT = 3;
export const DEFAULT_CUSTOMER_RECOMMENDATION_LIMIT = 5;
export const MAX_CUSTOMER_RECOMMENDATIONS = 8;

export const customerRecommendationReasons = [
  "frequently_ordered",
  "recently_ordered",
  "popular",
  "active_promo"
] as const;

export type CustomerRecommendationReason =
  (typeof customerRecommendationReasons)[number];

export interface CustomerRecommendationCandidate {
  name: string;
  description?: string;
  price: number;
  imageUrl?: string;
  reasons: CustomerRecommendationReason[];
}

type RecommendationProfileSource = Pick<
  ICustomerProfileDocument,
  "restaurantId" | "frequentlyOrderedItems"
>;

type RecommendationOrderSource = Pick<
  IOrderDocument,
  "restaurantId" | "status" | "items"
>;

type RecommendationMenuItemSource = Pick<
  IMenuItemDocument,
  | "_id"
  | "restaurantId"
  | "name"
  | "description"
  | "price"
  | "imageUrl"
  | "isAvailable"
  | "isPopular"
  | "isPromoItem"
>;

interface RecommendationBuildInput {
  restaurantId: string;
  profile?: RecommendationProfileSource | null;
  recentOrders: readonly RecommendationOrderSource[];
  menuItems: readonly RecommendationMenuItemSource[];
  limit?: number;
}

interface ScoredRecommendation {
  candidate: CustomerRecommendationCandidate;
  score: number;
  isPopular: boolean;
  isPromoItem: boolean;
}

const ensureValidRestaurantId = (restaurantId: string): void => {
  if (!Types.ObjectId.isValid(restaurantId)) {
    throw new BadRequestError("Invalid restaurantId");
  }
};

const ensureRecommendationLimit = (limit: number): number => {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_CUSTOMER_RECOMMENDATIONS
  ) {
    throw new BadRequestError(
      `Recommendation limit must be between 1 and ${MAX_CUSTOMER_RECOMMENDATIONS}`
    );
  }

  return limit;
};

const getProfileFrequencyByItemId = (
  restaurantId: string,
  profile?: RecommendationProfileSource | null
): Map<string, number> => {
  const frequencyByItemId = new Map<string, number>();

  if (!profile || String(profile.restaurantId) !== restaurantId) {
    return frequencyByItemId;
  }

  for (const item of profile.frequentlyOrderedItems ?? []) {
    const itemId = String(item.menuItemId);
    frequencyByItemId.set(
      itemId,
      Math.max(frequencyByItemId.get(itemId) ?? 0, item.orderCount)
    );
  }

  return frequencyByItemId;
};

const getRecentScoreByItemId = (
  restaurantId: string,
  recentOrders: readonly RecommendationOrderSource[]
): Map<string, number> => {
  const recentScoreByItemId = new Map<string, number>();

  recentOrders
    .filter(
      (order) =>
        String(order.restaurantId) === restaurantId &&
        order.status === "completed"
    )
    .slice(0, CUSTOMER_RECOMMENDATION_RECENT_ORDER_LIMIT)
    .forEach((order, orderIndex) => {
      const score =
        12 +
        (CUSTOMER_RECOMMENDATION_RECENT_ORDER_LIMIT - orderIndex) * 4;

      for (const item of order.items) {
        const itemId = String(item.menuItemId);
        recentScoreByItemId.set(
          itemId,
          Math.max(recentScoreByItemId.get(itemId) ?? 0, score)
        );
      }
    });

  return recentScoreByItemId;
};

export const buildGroundedCustomerRecommendations = ({
  restaurantId,
  profile,
  recentOrders,
  menuItems,
  limit = DEFAULT_CUSTOMER_RECOMMENDATION_LIMIT
}: RecommendationBuildInput): CustomerRecommendationCandidate[] => {
  const safeLimit = ensureRecommendationLimit(limit);
  const frequencyByItemId = getProfileFrequencyByItemId(
    restaurantId,
    profile
  );
  const recentScoreByItemId = getRecentScoreByItemId(
    restaurantId,
    recentOrders
  );
  const candidatesByItemId = new Map<string, ScoredRecommendation>();

  for (const item of menuItems) {
    if (
      String(item.restaurantId) !== restaurantId ||
      item.isAvailable !== true
    ) {
      continue;
    }

    const itemId = String(item._id);
    const frequentOrderCount = frequencyByItemId.get(itemId) ?? 0;
    const recentScore = recentScoreByItemId.get(itemId) ?? 0;
    const reasons: CustomerRecommendationReason[] = [];
    let score = 0;

    if (frequentOrderCount > 0) {
      reasons.push("frequently_ordered");
      score += 50 + Math.min(frequentOrderCount, 20) * 2;
    }

    if (recentScore > 0) {
      reasons.push("recently_ordered");
      score += recentScore;
    }

    if (item.isPopular) {
      reasons.push("popular");
      score += 25;
    }

    if (item.isPromoItem) {
      reasons.push("active_promo");
      score += 20;
    }

    if (reasons.length === 0) {
      continue;
    }

    const existing = candidatesByItemId.get(itemId);
    const scoredCandidate: ScoredRecommendation = {
      candidate: {
        name: item.name,
        description: item.description,
        price: item.price,
        imageUrl: item.imageUrl,
        reasons
      },
      score,
      isPopular: item.isPopular,
      isPromoItem: item.isPromoItem
    };

    if (!existing || scoredCandidate.score > existing.score) {
      candidatesByItemId.set(itemId, scoredCandidate);
    }
  }

  return Array.from(candidatesByItemId.values())
    .sort((left, right) => {
      return (
        right.score - left.score ||
        Number(right.isPromoItem) - Number(left.isPromoItem) ||
        Number(right.isPopular) - Number(left.isPopular) ||
        left.candidate.name.localeCompare(right.candidate.name)
      );
    })
    .slice(0, safeLimit)
    .map(({ candidate }) => candidate);
};

export const getCustomerRecommendations = async (
  restaurantId: string,
  customerPhone: string,
  limit = DEFAULT_CUSTOMER_RECOMMENDATION_LIMIT
): Promise<CustomerRecommendationCandidate[]> => {
  ensureValidRestaurantId(restaurantId);
  const safeLimit = ensureRecommendationLimit(limit);
  const normalizedPhone = normalizeGhanaPhone(customerPhone);
  const [profile, recentOrders] = await Promise.all([
    CustomerProfile.findOne({
      restaurantId,
      customerPhone: normalizedPhone
    }).select(
      "restaurantId frequentlyOrderedItems.menuItemId frequentlyOrderedItems.orderCount"
    ),
    Order.find({
      restaurantId,
      customerPhone: {
        $in: getEquivalentCustomerPhones(customerPhone)
      },
      status: "completed"
    })
      .select("restaurantId status items.menuItemId")
      .sort({ completedAt: -1, updatedAt: -1, createdAt: -1 })
      .limit(CUSTOMER_RECOMMENDATION_RECENT_ORDER_LIMIT)
  ]);
  const frequentItemIds =
    profile && String(profile.restaurantId) === restaurantId
      ? profile.frequentlyOrderedItems.map((item) => item.menuItemId)
      : [];
  const recentItemIds = recentOrders
    .filter(
      (order) =>
        String(order.restaurantId) === restaurantId &&
        order.status === "completed"
    )
    .flatMap((order) => order.items.map((item) => item.menuItemId));
  const historicalItemIds = Array.from(
    new Set(
      [...frequentItemIds, ...recentItemIds].map((itemId) =>
        String(itemId)
      )
    )
  );
  const candidateConditions: Record<string, unknown>[] = [
    { isPopular: true },
    { isPromoItem: true }
  ];

  if (historicalItemIds.length > 0) {
    candidateConditions.push({
      _id: {
        $in: historicalItemIds
      }
    });
  }

  const menuItems = await MenuItem.find({
    restaurantId,
    isAvailable: true,
    $or: candidateConditions
  }).select(
    "restaurantId name description price imageUrl isAvailable isPopular isPromoItem"
  );

  return buildGroundedCustomerRecommendations({
    restaurantId,
    profile,
    recentOrders,
    menuItems,
    limit: safeLimit
  });
};
