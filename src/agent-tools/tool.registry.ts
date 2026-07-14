import { Types } from "mongoose";
import { z } from "zod";
import { MenuCategory } from "../models/MenuCategory";
import { MenuItem, type IMenuItemDocument } from "../models/MenuItem";
import { Order, orderStatuses, type IOrderDocument, type OrderStatus } from "../models/order.model";
import { PendingAgentAction } from "../models/pendingAgentAction.model";
import * as menuItemService from "../services/menuItem.service";
import * as orderService from "../services/order.service";
import type { RegisteredTool, ToolExecutionContext, ToolResult } from "../types/agent.types";
import { normalizeGhanaPhone } from "../utils/phone.util";
import { toolPermissions, type ToolName } from "./tool.permissions";

const emptySchema = z.object({}).strict();
const orderLookupSchema = z
  .object({
    orderReference: z.string().trim().min(1).optional(),
    orderId: z.string().trim().min(1).optional()
  })
  .strict();
const menuItemLookupSchema = z
  .object({
    itemName: z.string().trim().min(1).optional(),
    itemId: z.string().trim().min(1).optional()
  })
  .strict();
const addMenuItemsSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            name: z.string().trim().min(1),
            price: z.number().positive(),
            categoryName: z.string().trim().min(1).optional(),
            description: z.string().trim().min(1).optional(),
            isAvailable: z.boolean().optional()
          })
          .strict()
      )
      .min(1)
      .max(30)
  })
  .strict();

const defaultCategoryName = "Main Meals";

const menuItemView = (
  item: IMenuItemDocument,
  categoryNameById: Map<string, string>,
  includeInternal: boolean
) => ({
  id: includeInternal ? String(item._id) : undefined,
  name: item.name,
  description: item.description,
  price: item.price,
  category: categoryNameById.get(String(item.categoryId)),
  available: item.isAvailable,
  imageUrl: item.imageUrl,
  ...(includeInternal
    ? {
        categoryId: String(item.categoryId),
        tags: item.tags,
        allergens: item.allergens,
        isPopular: item.isPopular,
        isPromoItem: item.isPromoItem
      }
    : {})
});

const safeOrderView = (order: IOrderDocument, includeCustomer = false) => ({
  id: String(order._id),
  orderNumber: order.orderNumber,
  status: order.status,
  orderType: order.orderType,
  total: order.total,
  createdAt: order.createdAt,
  items: order.items.map((item) => ({
    name: item.name,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    totalPrice: item.totalPrice
  })),
  ...(includeCustomer
    ? {
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        deliveryAddress: order.deliveryAddress,
        paymentMethod: order.paymentMethod,
        paymentStatus: order.paymentStatus
      }
    : {})
});

const normalizeComparableText = (value: string): string => {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
};

const normalizeDisplayText = (value: string): string => {
  return value.trim().replace(/\s+/g, " ");
};

const getNextCategorySortOrder = async (restaurantId: string): Promise<number> => {
  const lastCategory = await MenuCategory.findOne({ restaurantId })
    .sort({ sortOrder: -1 })
    .select("sortOrder");

  return lastCategory ? lastCategory.sortOrder + 10 : 0;
};

const getOrCreateMenuCategory = async (restaurantId: string, categoryName: string) => {
  const normalizedCategoryName = normalizeDisplayText(categoryName);
  const categories = await MenuCategory.find({ restaurantId }).sort({ sortOrder: 1, createdAt: 1 });
  const existingCategory = categories.find(
    (category) =>
      normalizeComparableText(category.name) === normalizeComparableText(normalizedCategoryName)
  );

  if (existingCategory) {
    if (!existingCategory.isActive) {
      existingCategory.isActive = true;
      await existingCategory.save();
    }

    return existingCategory;
  }

  return MenuCategory.create({
    restaurantId,
    name: normalizedCategoryName,
    sortOrder: await getNextCategorySortOrder(restaurantId),
    isDefault: false,
    isActive: true
  });
};

const formatAddMenuItemsSummary = (items: z.infer<typeof addMenuItemsSchema>["items"]): string => {
  const categoryItems = new Map<string, string[]>();

  for (const item of items) {
    const categoryName = normalizeDisplayText(item.categoryName ?? defaultCategoryName);
    const summary = `${normalizeDisplayText(item.name)} (GHS ${item.price})`;
    categoryItems.set(categoryName, [...(categoryItems.get(categoryName) ?? []), summary]);
  }

  return Array.from(categoryItems.entries())
    .map(([categoryName, summaries]) => `${categoryName}: ${summaries.join(", ")}`)
    .join("\n");
};

const findMenuItemForRestaurant = async (
  context: ToolExecutionContext,
  args: z.infer<typeof menuItemLookupSchema>
): Promise<IMenuItemDocument | ToolResult> => {
  if (args.itemId) {
    if (!Types.ObjectId.isValid(args.itemId)) {
      return {
        success: false,
        code: "INVALID_MENU_ITEM_ID",
        message: "The menu item ID is invalid."
      };
    }

    const item = await MenuItem.findOne({
      _id: args.itemId,
      restaurantId: context.restaurantId
    });

    if (!item) {
      return {
        success: false,
        code: "MENU_ITEM_NOT_FOUND",
        message: "The requested menu item was not found."
      };
    }

    return item;
  }

  if (!args.itemName) {
    return {
      success: false,
      code: "MENU_ITEM_REQUIRED",
      message: "Please provide the menu item name."
    };
  }

  const items = await MenuItem.find({
    restaurantId: context.restaurantId,
    name: {
      $regex: args.itemName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      $options: "i"
    }
  }).sort({ createdAt: -1 });

  if (items.length === 0) {
    return {
      success: false,
      code: "MENU_ITEM_NOT_FOUND",
      message: "The requested menu item was not found."
    };
  }

  if (items.length > 1) {
    return {
      success: false,
      code: "MULTIPLE_MENU_ITEMS_FOUND",
      message: "Multiple menu items matched. Please be more specific.",
      data: items.map((item) => ({
        id: String(item._id),
        name: item.name,
        price: item.price,
        available: item.isAvailable
      }))
    };
  }

  return items[0];
};

const findOrderForRestaurant = async (
  context: ToolExecutionContext,
  args: z.infer<typeof orderLookupSchema>
): Promise<IOrderDocument | ToolResult> => {
  const reference = args.orderId ?? args.orderReference;

  if (!reference) {
    return {
      success: false,
      code: "ORDER_REFERENCE_REQUIRED",
      message: "Please provide the order reference."
    };
  }

  const query = Types.ObjectId.isValid(reference)
    ? {
        _id: reference,
        restaurantId: context.restaurantId
      }
    : {
        orderNumber: reference,
        restaurantId: context.restaurantId
      };
  const order = await Order.findOne(query);

  if (!order) {
    return {
      success: false,
      code: "ORDER_NOT_FOUND",
      message: "The requested order was not found."
    };
  }

  return order;
};

const createPendingToolAction = async (
  context: ToolExecutionContext,
  toolName: ToolName,
  args: Record<string, unknown>,
  summary: string
): Promise<ToolResult> => {
  const pendingAction = await PendingAgentAction.create({
    restaurantId: context.restaurantId,
    senderPhone: context.sender.normalizedPhone,
    senderRole: context.sender.role,
    action: "TOOL_CALL",
    toolName,
    arguments: args,
    data: args,
    status: "pending",
    summary,
    confirmationMessage: summary,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000)
  });

  console.info("Agent confirmation created", {
    restaurantId: context.restaurantId,
    senderRole: context.sender.role,
    toolName
  });

  return {
    success: true,
    requiresConfirmation: true,
    pendingActionId: String(pendingAction._id),
    message: summary
  };
};

const getMenuData = async (context: ToolExecutionContext, availableOnly = false) => {
  const includeInternal = context.sender.role !== "customer";
  const [categories, items] = await Promise.all([
    MenuCategory.find({
      restaurantId: context.restaurantId,
      ...(includeInternal ? {} : { isActive: true })
    }).sort({ sortOrder: 1, createdAt: 1 }),
    MenuItem.find({
      restaurantId: context.restaurantId,
      ...(availableOnly ? { isAvailable: true } : {})
    }).sort({ createdAt: -1 })
  ]);
  const categoryNameById = new Map(categories.map((category) => [String(category._id), category.name]));

  return categories.map((category) => ({
    id: includeInternal ? String(category._id) : undefined,
    name: category.name,
    description: category.description,
    active: includeInternal ? category.isActive : undefined,
    items: items
      .filter((item) => String(item.categoryId) === String(category._id))
      .filter((item) => includeInternal || item.isAvailable)
      .map((item) => menuItemView(item, categoryNameById, includeInternal))
  }));
};

const startOfToday = (): Date => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
};

export const toolRegistry: Record<ToolName, RegisteredTool> = {
  get_restaurant_profile: {
    definition: {
      name: "get_restaurant_profile",
      description: "Read role-appropriate restaurant profile and settings.",
      parameters: {}
    },
    roles: toolPermissions.get_restaurant_profile,
    schema: emptySchema,
    handler: async (_args, context) => ({
      success: true,
      message: "Restaurant profile retrieved successfully.",
      data: {
        name: context.restaurant.name,
        slug: context.restaurant.slug,
        cuisine: context.restaurant.primaryCuisine,
        status: context.sender.role === "customer" ? undefined : context.restaurant.status,
        pickupAddress: context.restaurant.pickupAddress,
        whatsappNumber: context.restaurant.whatsappNumber,
        ownerName: context.sender.role === "customer" ? undefined : context.restaurant.ownerName,
        openingHours: context.restaurant.openingHours,
        deliveryEnabled: context.restaurant.deliveryEnabled,
        assistantTone: context.sender.role === "customer" ? undefined : context.restaurant.assistantTone
      }
    })
  },
  get_menu: {
    definition: {
      name: "get_menu",
      description: "Return active menu categories and menu items for the current restaurant.",
      parameters: {
        availableOnly: "Optional boolean. If true, return only available items."
      }
    },
    roles: toolPermissions.get_menu,
    schema: z.object({ availableOnly: z.boolean().optional() }).strict(),
    handler: async (args, context) => ({
      success: true,
      message: "Menu retrieved successfully.",
      data: await getMenuData(context, args.availableOnly ?? context.sender.role === "customer")
    })
  },
  search_menu_items: {
    definition: {
      name: "search_menu_items",
      description: "Search menu items by text and optional category.",
      parameters: {
        query: "Search text.",
        category: "Optional category name.",
        availableOnly: "Optional boolean."
      }
    },
    roles: toolPermissions.search_menu_items,
    schema: z
      .object({
        query: z.string().trim().min(1),
        category: z.string().trim().min(1).optional(),
        availableOnly: z.boolean().optional()
      })
      .strict(),
    handler: async (args, context) => {
      const includeInternal = context.sender.role !== "customer";
      const categories = await MenuCategory.find({
        restaurantId: context.restaurantId,
        ...(args.category
          ? {
              name: {
                $regex: args.category.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
                $options: "i"
              }
            }
          : {})
      });
      const categoryIds = categories.map((category) => category._id);
      const categoryNameById = new Map(categories.map((category) => [String(category._id), category.name]));
      const items = await MenuItem.find({
        restaurantId: context.restaurantId,
        ...(categoryIds.length > 0 ? { categoryId: { $in: categoryIds } } : {}),
        ...(args.availableOnly ?? context.sender.role === "customer" ? { isAvailable: true } : {}),
        name: {
          $regex: args.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          $options: "i"
        }
      }).sort({ createdAt: -1 });

      return {
        success: true,
        message: "Menu search completed.",
        data: items.map((item) => menuItemView(item, categoryNameById, includeInternal))
      };
    }
  },
  get_today_orders: {
    definition: {
      name: "get_today_orders",
      description: "Return today's order summary for the current restaurant.",
      parameters: {}
    },
    roles: toolPermissions.get_today_orders,
    schema: emptySchema,
    handler: async (_args, context) => {
      const orders = await Order.find({
        restaurantId: context.restaurantId,
        createdAt: { $gte: startOfToday() }
      });
      const countByStatus = new Map(orderStatuses.map((status) => [status, 0]));

      for (const order of orders) {
        countByStatus.set(order.status, (countByStatus.get(order.status) ?? 0) + 1);
      }

      return {
        success: true,
        message: "Today's orders retrieved successfully.",
        data: {
          totalOrders: orders.length,
          revenue: orders.reduce((sum, order) => sum + order.total, 0),
          statuses: Object.fromEntries(countByStatus)
        }
      };
    }
  },
  get_order_details: {
    definition: {
      name: "get_order_details",
      description: "Get details for one order. Customers can only read their own orders.",
      parameters: {
        orderReference: "Order number or order ID."
      }
    },
    roles: toolPermissions.get_order_details,
    schema: orderLookupSchema,
    handler: async (args, context) => {
      const order = await findOrderForRestaurant(context, args);

      if ("success" in order) {
        return order;
      }

      const isCustomer = context.sender.role === "customer";

      if (
        isCustomer &&
        normalizeGhanaPhone(order.customerPhone) !== context.sender.normalizedPhone
      ) {
        return {
          success: false,
          code: "ORDER_FORBIDDEN",
          message: "That order is not available for this customer."
        };
      }

      return {
        success: true,
        message: "Order details retrieved successfully.",
        data: safeOrderView(order, !isCustomer)
      };
    }
  },
  get_business_summary: {
    definition: {
      name: "get_business_summary",
      description: "Return a compact business overview for owner or manager.",
      parameters: {}
    },
    roles: toolPermissions.get_business_summary,
    schema: emptySchema,
    handler: async (_args, context) => {
      const todayOrders = await Order.find({
        restaurantId: context.restaurantId,
        createdAt: { $gte: startOfToday() }
      });
      const unavailableItems = await MenuItem.countDocuments({
        restaurantId: context.restaurantId,
        isAvailable: false
      });

      return {
        success: true,
        message: "Business summary retrieved successfully.",
        data: {
          todayOrderCount: todayOrders.length,
          todayRevenue: todayOrders.reduce((sum, order) => sum + order.total, 0),
          pendingOrders: todayOrders.filter((order) => order.status === "pending").length,
          unavailableItems
        }
      };
    }
  },
  add_menu_items: {
    definition: {
      name: "add_menu_items",
      description:
        "Prepare or confirm adding one or more menu items. Creates menu categories by name when needed. Requires owner confirmation.",
      parameters: {
        items:
          "Array of { name, price, categoryName, description, isAvailable }. categoryName is optional and defaults to Main Meals."
      }
    },
    roles: toolPermissions.add_menu_items,
    sensitive: true,
    schema: addMenuItemsSchema,
    handler: async (args, context) => {
      if (!context.confirmed) {
        const itemCount = args.items.length;

        return createPendingToolAction(
          context,
          "add_menu_items",
          args,
          [
            `Should I add ${itemCount} menu item${itemCount === 1 ? "" : "s"}?`,
            formatAddMenuItemsSummary(args.items)
          ].join("\n")
        );
      }

      const createdItems = [];

      for (const item of args.items) {
        const categoryName = normalizeDisplayText(item.categoryName ?? defaultCategoryName);
        const category = await getOrCreateMenuCategory(context.restaurantId, categoryName);
        const createdItem = await menuItemService.addMenuItem(context.restaurantId, {
          categoryId: String(category._id),
          name: normalizeDisplayText(item.name),
          price: item.price,
          description: item.description ? normalizeDisplayText(item.description) : undefined,
          isAvailable: item.isAvailable ?? true
        });

        createdItems.push({
          id: String(createdItem._id),
          name: createdItem.name,
          price: createdItem.price,
          category: category.name,
          available: createdItem.isAvailable
        });
      }

      return {
        success: true,
        message: `${createdItems.length} menu item${
          createdItems.length === 1 ? " has" : "s have"
        } been added.`,
        data: {
          items: createdItems
        }
      };
    }
  },
  update_menu_price: {
    definition: {
      name: "update_menu_price",
      description: "Prepare or confirm changing a menu item's price. Requires owner confirmation.",
      parameters: {
        itemName: "Menu item name.",
        itemId: "Optional menu item ID.",
        newPrice: "Positive new price."
      }
    },
    roles: toolPermissions.update_menu_price,
    sensitive: true,
    schema: menuItemLookupSchema
      .extend({
        newPrice: z.number().positive()
      })
      .strict(),
    handler: async (args, context) => {
      const item = await findMenuItemForRestaurant(context, args);

      if ("success" in item) {
        return item;
      }

      if (!context.confirmed) {
        return createPendingToolAction(
          context,
          "update_menu_price",
          { itemId: String(item._id), newPrice: args.newPrice },
          `${item.name} is currently GHS ${item.price}. Should I change it to GHS ${args.newPrice}?`
        );
      }

      const previousPrice = item.price;
      const updated = await menuItemService.updateMenuItem(String(item._id), {
        price: args.newPrice
      });

      return {
        success: true,
        message: `${updated.name} is now GHS ${updated.price}.`,
        data: {
          itemName: updated.name,
          previousPrice,
          newPrice: updated.price
        }
      };
    }
  },
  set_item_availability: {
    definition: {
      name: "set_item_availability",
      description: "Prepare or confirm setting a menu item's availability.",
      parameters: {
        itemName: "Menu item name.",
        itemId: "Optional menu item ID.",
        available: "Boolean availability value."
      }
    },
    roles: toolPermissions.set_item_availability,
    sensitive: true,
    schema: menuItemLookupSchema
      .extend({
        available: z.boolean()
      })
      .strict(),
    handler: async (args, context) => {
      const item = await findMenuItemForRestaurant(context, args);

      if ("success" in item) {
        return item;
      }

      if (!context.confirmed) {
        return createPendingToolAction(
          context,
          "set_item_availability",
          { itemId: String(item._id), available: args.available },
          `Should I mark ${item.name} as ${args.available ? "available" : "unavailable"}?`
        );
      }

      const updated = await menuItemService.updateMenuItemAvailability(
        String(item._id),
        args.available
      );

      return {
        success: true,
        message: `${updated.name} has been marked ${updated.isAvailable ? "available" : "unavailable"}.`,
        data: {
          itemName: updated.name,
          available: updated.isAvailable
        }
      };
    }
  },
  confirm_order: {
    definition: {
      name: "confirm_order",
      description: "Confirm a pending order.",
      parameters: { orderReference: "Order number or order ID." }
    },
    roles: toolPermissions.confirm_order,
    schema: orderLookupSchema,
    handler: async (args, context) => {
      const order = await findOrderForRestaurant(context, args);

      if ("success" in order) {
        return order;
      }

      const result = await orderService.updateOrderStatus(String(order._id), "confirmed");

      return {
        success: true,
        message: "Order confirmed successfully.",
        data: safeOrderView(result.order, true)
      };
    }
  },
  update_order_status: {
    definition: {
      name: "update_order_status",
      description: "Update an order status.",
      parameters: {
        orderReference: "Order number or order ID.",
        status: orderStatuses.join(" | ")
      }
    },
    roles: toolPermissions.update_order_status,
    schema: orderLookupSchema
      .extend({
        status: z.enum(orderStatuses)
      })
      .strict(),
    handler: async (args, context) => {
      const order = await findOrderForRestaurant(context, args);

      if ("success" in order) {
        return order;
      }

      const result = await orderService.updateOrderStatus(String(order._id), args.status as OrderStatus);

      return {
        success: true,
        message: `Order status updated to ${result.order.status}.`,
        data: safeOrderView(result.order, true)
      };
    }
  },
  create_order: {
    definition: {
      name: "create_order",
      description: "Create a customer order from explicit menu item IDs and quantities.",
      parameters: {
        items: "Array of { menuItemId, quantity }.",
        orderType: "pickup or delivery.",
        deliveryAddress: "Required for delivery."
      }
    },
    roles: toolPermissions.create_order,
    schema: z
      .object({
        customerName: z.string().trim().optional(),
        items: z
          .array(z.object({ menuItemId: z.string().trim().min(1), quantity: z.number().int().positive() }))
          .min(1),
        orderType: z.enum(["pickup", "delivery"]),
        deliveryAddress: z.string().trim().optional(),
        notes: z.string().trim().optional()
      })
      .strict(),
    handler: async (args, context) => {
      const order = await orderService.createOrder(context.restaurantId, {
        customerName: args.customerName,
        customerPhone: context.sender.normalizedPhone,
        items: args.items,
        orderType: args.orderType,
        deliveryAddress: args.deliveryAddress,
        paymentMethod: "unknown",
        paymentStatus: "unpaid",
        notes: args.notes
      });

      return {
        success: true,
        message: "Order created successfully.",
        data: safeOrderView(order)
      };
    }
  },
  cancel_order: {
    definition: {
      name: "cancel_order",
      description: "Cancel an eligible order.",
      parameters: { orderReference: "Order number or order ID." }
    },
    roles: toolPermissions.cancel_order,
    sensitive: true,
    schema: orderLookupSchema,
    handler: async (args, context) => {
      const order = await findOrderForRestaurant(context, args);

      if ("success" in order) {
        return order;
      }

      if (
        context.sender.role === "customer" &&
        normalizeGhanaPhone(order.customerPhone) !== context.sender.normalizedPhone
      ) {
        return {
          success: false,
          code: "ORDER_FORBIDDEN",
          message: "That order is not available for this customer."
        };
      }

      if (["completed", "cancelled"].includes(order.status)) {
        return {
          success: false,
          code: "ORDER_NOT_CANCELLABLE",
          message: "This order cannot be cancelled in its current state."
        };
      }

      const result = await orderService.updateOrderStatus(String(order._id), "cancelled");

      return {
        success: true,
        message: "Order cancelled successfully.",
        data: safeOrderView(result.order, context.sender.role !== "customer")
      };
    }
  },
  get_delivery_information: {
    definition: {
      name: "get_delivery_information",
      description: "Return delivery and pickup information.",
      parameters: {}
    },
    roles: toolPermissions.get_delivery_information,
    schema: emptySchema,
    handler: async (_args, context) => ({
      success: true,
      message: "Delivery information retrieved successfully.",
      data: {
        deliveryEnabled: context.restaurant.deliveryEnabled,
        deliveryRadiusKm: context.restaurant.deliveryRadiusKm,
        deliveryAreas: context.restaurant.deliveryAreas,
        minimumOrderValue: context.restaurant.minimumOrderValue,
        pickupAddress: context.restaurant.pickupAddress,
        takeawayEnabled: context.restaurant.allowTakeaway,
        deliveryFeeNote: context.restaurant.deliveryFeeNote
      }
    })
  }
};

export const getToolDefinitionsForRole = (role: ToolExecutionContext["sender"]["role"]) => {
  return Object.values(toolRegistry)
    .filter((tool) => tool.roles.includes(role))
    .map((tool) => tool.definition);
};
