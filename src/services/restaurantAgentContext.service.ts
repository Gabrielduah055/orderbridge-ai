import { MenuCategory } from "../models/MenuCategory";
import { MenuItem } from "../models/MenuItem";
import { Order } from "../models/order.model";
import type { IRestaurantDocument } from "../models/Restaurant";
import type { ResolvedSender, RestaurantAgentContext } from "../types/agent.types";

const activeOrderStatuses = ["pending", "confirmed", "preparing", "ready", "out_for_delivery"];

export const buildRestaurantAgentContext = async (
  restaurant: IRestaurantDocument,
  sender: ResolvedSender,
  permissions: string[]
): Promise<RestaurantAgentContext> => {
  const restaurantId = String(restaurant._id);
  const [activeCategories, activeMenuItems, unavailableMenuItems, activeOrders] =
    await Promise.all([
      MenuCategory.countDocuments({
        restaurantId,
        isActive: true
      }),
      MenuItem.countDocuments({
        restaurantId,
        isAvailable: true
      }),
      MenuItem.countDocuments({
        restaurantId,
        isAvailable: false
      }),
      Order.countDocuments({
        restaurantId,
        status: {
          $in: activeOrderStatuses
        }
      })
    ]);

  return {
    restaurant: {
      id: restaurantId,
      name: restaurant.name,
      slug: restaurant.slug,
      cuisine: restaurant.primaryCuisine,
      location: restaurant.pickupAddress,
      status: restaurant.status
    },
    sender: {
      name: sender.name,
      phone: sender.normalizedPhone,
      role: sender.role,
      verified: sender.verified
    },
    people: {
      ownerName: restaurant.ownerName,
      managerName: sender.role === "manager" ? sender.name : undefined
    },
    settings: {
      deliveryEnabled: restaurant.deliveryEnabled,
      deliveryRadiusKm: restaurant.deliveryRadiusKm,
      minimumOrderValue: restaurant.minimumOrderValue,
      takeawayEnabled: restaurant.allowTakeaway,
      freeDeliveryThresholdEnabled: restaurant.freeDeliveryThresholdEnabled,
      deliveryFeeNote: restaurant.deliveryFeeNote,
      openingHours: restaurant.openingHours,
      assistantTone: restaurant.assistantTone
    },
    summary: {
      activeCategories,
      activeMenuItems,
      unavailableMenuItems,
      activeOrders
    },
    permissions
  };
};
