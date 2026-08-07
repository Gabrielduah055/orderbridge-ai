import { Types } from "mongoose";
import { z } from "zod";
import { MenuCategory } from "../models/MenuCategory";
import { MenuItem, type IMenuItemDocument } from "../models/MenuItem";
import { Order, orderStatuses, type IOrderDocument, type OrderStatus } from "../models/order.model";
import { PendingAgentAction } from "../models/pendingAgentAction.model";
import * as menuItemService from "../services/menuItem.service";
import * as orderService from "../services/order.service";
import * as customerRecommendationService from "../services/customerRecommendation.service";
import {
  approveCustomerCampaign,
  approveCampaignSchema,
  buildCustomerCampaignPreviewMessage,
  campaignIdSchema,
  cancelCustomerCampaign,
  createCustomerCampaignDraft,
  createCustomerCampaignDraftSchema,
  listCustomerCampaigns,
  listCustomerCampaignsSchema,
  previewCustomerCampaign
} from "../services/customerCampaign.service";
import { getCustomerMarketingPreference } from "../services/customerMarketingPreference.service";
import {
  getCurrentDailySummaryPeriod,
  getOwnerSummaryMetrics
} from "../services/ownerSummary.service";
import {
  buildClarificationCandidate,
  cancelPendingOrderItemClarifications,
  createOrderItemClarification,
  findActiveOrderItemClarification,
  resolveOrderItemClarification
} from "../services/agentClarification.service";
import {
  addItemToDraft,
  addPendingItemToDraft,
  buildDraftView,
  clearConvertedDraftState,
  clearPendingCategory,
  clearPendingMenuItem,
  findActiveDraft,
  findMenuItemMatch,
  findMenuItemMatchInCategory,
  getCartItemDisplayName,
  getMenuItemDisplayName,
  getMissingDraftFields,
  getDraftMissingFieldCode,
  getOrCreateDraft,
  removeItemFromDraft,
  resetDraftState,
  parseExplicitQuantity,
  resolveTrustedQuantity,
  submitOrderDraft
} from "../services/orderDraft.service";
import type { RegisteredTool, ToolExecutionContext, ToolResult } from "../types/agent.types";
import { BadRequestError } from "../utils/httpErrors";
import { normalizeGhanaPhone } from "../utils/phone.util";
import {
  OrderFeedback,
  orderFeedbackTypes,
  type IOrderFeedbackDocument
} from "../models/orderFeedback.model";
import {
  listCustomerFeedback,
  resolveCustomerFeedback
} from "../services/orderFeedback.service";
import { toolPermissions, type ToolName } from "./tool.permissions";
import {
  assignPendingImageToMenuItem,
  cancelPendingMenuItemImageConfirmation,
  confirmPendingMenuItemImage,
  startMenuItemImageUpload
} from "../services/menuItemImageWorkflow.service";

const emptySchema = z.object({}).strict();
const orderLookupSchema = z
  .object({
    orderReference: z.string().trim().min(1).optional(),
    orderId: z.string().trim().min(1).optional()
  })
  .strict();
const rejectOrderSchema = orderLookupSchema
  .extend({
    reason: z.string().trim().min(1).optional()
  })
  .strict();
const listOrdersSchema = z
  .object({
    status: z.enum(orderStatuses).optional(),
    date: z.enum(["today", "yesterday"]).optional(),
    limit: z.number().int().positive().max(25).optional()
  })
  .strict();
const listCustomerFeedbackSchema = z
  .object({
    type: z.enum(orderFeedbackTypes).optional(),
    requiresAttention: z.boolean().optional(),
    limit: z.number().int().positive().max(20).optional()
  })
  .strict();
const resolveCustomerFeedbackSchema = z
  .object({
    feedbackId: z.string().trim().min(1)
  })
  .strict();
const menuItemLookupSchema = z
  .object({
    itemName: z.string().trim().min(1).optional(),
    itemId: z.string().trim().min(1).optional()
  })
  .strict();
const objectIdSchema = z
  .string()
  .trim()
  .refine((value) => Types.ObjectId.isValid(value), "A valid ID is required.");
const startMenuItemImageUploadSchema = z
  .object({
    itemName: z.string().trim().min(1).optional(),
    itemId: objectIdSchema.optional()
  })
  .strict();
const pendingImageActionSchema = z
  .object({
    pendingActionId: objectIdSchema
  })
  .strict();
const pendingImageAssignmentSchema = z
  .object({
    pendingActionId: objectIdSchema,
    itemName: z.string().trim().min(1).optional(),
    itemId: objectIdSchema.optional()
  })
  .strict()
  .refine((args) => Boolean(args.itemName || args.itemId), {
    message: "Provide either itemName or itemId."
  });

const logImageWorkflowToolResult = (
  tool: ToolName,
  context: ToolExecutionContext,
  result: ToolResult,
  stage: string,
  pendingActionId?: string
): ToolResult => {
  console.info("[imageWorkflow] tool handled", {
    tool,
    restaurantId: context.restaurantId,
    senderRole: context.sender.role,
    pendingActionId: result.pendingActionId ?? pendingActionId,
    stage: result.success ? stage : "unchanged",
    success: result.success,
    code: result.code
  });

  return result;
};
const startOrderSchema = z
  .object({
    customerName: z.string().trim().min(1).optional()
  })
  .strict();
const addOrderItemByNameSchema = z
  .object({
    itemName: z.string().trim().min(1),
    quantity: z.number().int().positive().optional()
  })
  .strict();
const removeOrderItemByNameSchema = z
  .object({
    itemName: z.string().trim().min(1),
    quantity: z.number().int().positive().optional()
  })
  .strict();
const updateOrderItemQuantitySchema = z
  .object({
    itemName: z.string().trim().min(1),
    newQuantity: z.number().int().positive()
  })
  .strict();
const updateOrderDraftSchema = z
  .object({
    customerName: z.string().trim().min(1).optional(),
    orderType: z.enum(["pickup", "delivery"]).optional(),
    deliveryAddress: z.string().trim().min(1).optional()
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
  subtotal: order.subtotal,
  deliveryFee: order.deliveryFee,
  deliveryFeePending: order.deliveryFeePending,
  deliveryFeeSource: order.deliveryFeeSource,
  total: order.total,
  createdAt: order.createdAt,
  customerConfirmedAt: order.customerConfirmedAt,
  ownerNotifiedAt: order.ownerNotifiedAt,
  restaurantConfirmedAt: order.restaurantConfirmedAt,
  restaurantRejectedAt: order.restaurantRejectedAt,
  restaurantRejectionReason: includeCustomer ? order.restaurantRejectionReason : undefined,
  receiptUrl: includeCustomer ? order.receiptUrl : undefined,
  receiptGeneratedAt: order.receiptGeneratedAt,
  receiptSentAt: order.receiptSentAt,
  completedAt: order.completedAt,
  completionSource: order.completionSource,
  completionConfirmedByCustomer: order.completionConfirmedByCustomer,
  customerConfirmedReceiptAt: order.customerConfirmedReceiptAt,
  feedbackFollowUpStatus: order.feedbackFollowUpStatus,
  feedbackRequestSentAt: order.feedbackRequestSentAt,
  feedbackReceivedAt: order.feedbackReceivedAt,
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

const safeFeedbackView = (feedback: IOrderFeedbackDocument) => ({
  id: String(feedback._id),
  orderId: String(feedback.orderId),
  orderNumber: feedback.orderNumber,
  customerName: feedback.customerName,
  customerPhone: feedback.customerPhone,
  type: feedback.type,
  message: feedback.message,
  summary: feedback.summary,
  sentiment: feedback.sentiment,
  rating: feedback.rating,
  requiresOwnerAttention: feedback.requiresOwnerAttention,
  ownerNotifiedAt: feedback.ownerNotifiedAt,
  ownerNotificationFailedAt: feedback.ownerNotificationFailedAt,
  resolvedAt: feedback.resolvedAt,
  resolvedByPhone: feedback.resolvedByPhone,
  createdAt: feedback.createdAt
});

const normalizeComparableText = (value: string): string => {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
};

const normalizeDisplayText = (value: string): string => {
  return value.trim().replace(/\s+/g, " ");
};

const getMenuItemCategoryName = (item: IMenuItemDocument): string | undefined => {
  return (item as IMenuItemDocument & { categoryName?: string }).categoryName;
};

const getClarificationCandidateDisplayName = (candidate: {
  name: string;
  categoryName?: string;
}): string => getMenuItemDisplayName({ name: candidate.name }, candidate.categoryName);

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
  // Cancel any stale TOOL_CALL pending actions for this sender before creating a new one.
  // Without this, every AI proposal creates a new pending action and they accumulate,
  // causing the "more than one action awaiting confirmation" loop.
  await PendingAgentAction.updateMany(
    {
      restaurantId: context.restaurantId,
      senderPhone: context.sender.normalizedPhone,
      action: "TOOL_CALL",
      status: "pending"
    },
    {
      $set: {
        status: "cancelled",
        resultMessage: "Superseded by a newer pending action."
      }
    }
  );

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

const startOfYesterday = (): Date => {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  date.setHours(0, 0, 0, 0);
  return date;
};

const endOfYesterday = (): Date => {
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
  get_customer_recommendations: {
    definition: {
      name: "get_customer_recommendations",
      description:
        "Return backend-ranked, currently available menu recommendations for this customer. Use only these candidates when phrasing recommendations; never add items that are not returned.",
      parameters: {
        limit: `Optional number of recommendations, from 1 to ${customerRecommendationService.MAX_CUSTOMER_RECOMMENDATIONS}.`
      }
    },
    roles: toolPermissions.get_customer_recommendations,
    schema: z
      .object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(customerRecommendationService.MAX_CUSTOMER_RECOMMENDATIONS)
          .optional()
      })
      .strict(),
    handler: async (args, context) => {
      const recommendations =
        await customerRecommendationService.getCustomerRecommendations(
          context.restaurantId,
          context.sender.normalizedPhone,
          args.limit
        );

      return {
        success: true,
        message:
          recommendations.length > 0
            ? "Grounded customer recommendations retrieved successfully."
            : "No grounded recommendations are currently available.",
        data: {
          recommendations
        }
      };
    }
  },
  get_marketing_preference: {
    definition: {
      name: "get_marketing_preference",
      description:
        "Read this customer's restaurant-scoped promotional messaging preference. Preference changes themselves are handled only by explicit deterministic customer commands such as STOP or START.",
      parameters: {}
    },
    roles: toolPermissions.get_marketing_preference,
    schema: emptySchema,
    handler: async (_args, context) => ({
      success: true,
      message: "Marketing preference retrieved.",
      data: await getCustomerMarketingPreference(
        context.restaurantId,
        context.sender.normalizedPhone
      )
    })
  },
  get_today_orders: {
    definition: {
      name: "get_today_orders",
      description:
        "Return today's order counts and completed-order revenue for the current restaurant.",
      parameters: {}
    },
    roles: toolPermissions.get_today_orders,
    schema: emptySchema,
    handler: async (_args, context) => {
      const period = getCurrentDailySummaryPeriod(
        new Date(),
        context.restaurant.timezone
      );
      const metrics = await getOwnerSummaryMetrics({
        restaurantId: context.restaurantId,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        timezone: period.timezone,
        periodType: period.type
      });

      return {
        success: true,
        message: "Today's orders retrieved successfully.",
        data: {
          ...metrics,
          revenue: metrics.completedRevenue,
          statuses: metrics.countsByStatus
        }
      };
    }
  },
  get_yesterday_orders: {
    definition: {
      name: "get_yesterday_orders",
      description:
        "Return yesterday's order counts and completed-order revenue for the current restaurant.",
      parameters: {}
    },
    roles: toolPermissions.get_today_orders,
    schema: emptySchema,
    handler: async (_args, context) => {
      const period = getCurrentDailySummaryPeriod(
        new Date(Date.now() - 24 * 60 * 60 * 1000),
        context.restaurant.timezone
      );
      const metrics = await getOwnerSummaryMetrics({
        restaurantId: context.restaurantId,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        timezone: period.timezone,
        periodType: period.type
      });

      return {
        success: true,
        message: "Yesterday's orders retrieved successfully.",
        data: {
          ...metrics,
          revenue: metrics.completedRevenue,
          statuses: metrics.countsByStatus
        }
      };
    }
  },
  list_orders: {
    definition: {
      name: "list_orders",
      description:
        "Owner/manager. List recent orders for this restaurant, optionally filtered by status and today's/yesterday's date.",
      parameters: {
        status: orderStatuses.join(" | "),
        date: "Optional. Use today or yesterday to limit the list.",
        limit: "Optional max number of orders, up to 25."
      }
    },
    roles: toolPermissions.list_orders,
    schema: listOrdersSchema,
    handler: async (args, context) => {
      const dateFilter: Record<string, unknown> = {};

      if (args.date === "today") {
        dateFilter.createdAt = { $gte: startOfToday() };
      } else if (args.date === "yesterday") {
        dateFilter.createdAt = { $gte: startOfYesterday(), $lt: endOfYesterday() };
      }

      const orders = await Order.find({
        restaurantId: context.restaurantId,
        ...(args.status ? { status: args.status } : {}),
        ...dateFilter
      })
        .sort({ createdAt: -1 })
        .limit(args.limit ?? 10);

      return {
        success: true,
        message: "Orders retrieved successfully.",
        data: orders.map((order) => safeOrderView(order, true))
      };
    }
  },
  list_customer_feedback: {
    definition: {
      name: "list_customer_feedback",
      description:
        "Owner/manager only. List recent restaurant-scoped customer reviews, complaints, suggestions, system feedback, and non-delivery reports.",
      parameters: {
        type: orderFeedbackTypes.join(" | "),
        requiresAttention: "Optional boolean attention filter.",
        limit: "Optional maximum number of records, up to 20."
      }
    },
    roles: toolPermissions.list_customer_feedback,
    schema: listCustomerFeedbackSchema,
    handler: async (args, context) => {
      const feedback = await listCustomerFeedback(context.restaurantId, args);

      return {
        success: true,
        message:
          feedback.length === 0
            ? "No customer feedback matched those filters."
            : `${feedback.length} customer feedback record${feedback.length === 1 ? "" : "s"} retrieved.`,
        data: feedback.map(safeFeedbackView)
      };
    }
  },
  resolve_customer_feedback: {
    definition: {
      name: "resolve_customer_feedback",
      description:
        "Owner/manager only. Resolve a restaurant-scoped customer feedback record after explicit confirmation. Feedback is retained.",
      parameters: {
        feedbackId: "Feedback record ID."
      }
    },
    roles: toolPermissions.resolve_customer_feedback,
    sensitive: true,
    schema: resolveCustomerFeedbackSchema,
    handler: async (args, context) => {
      if (!Types.ObjectId.isValid(args.feedbackId)) {
        return {
          success: false,
          code: "FEEDBACK_NOT_FOUND",
          message: "The requested customer feedback was not found."
        };
      }

      const feedback = await OrderFeedback.findOne({
        _id: args.feedbackId,
        restaurantId: context.restaurantId
      });

      if (!feedback) {
        return {
          success: false,
          code: "FEEDBACK_NOT_FOUND",
          message: "The requested customer feedback was not found."
        };
      }

      if (feedback.resolvedAt) {
        return {
          success: true,
          message: "That feedback was already resolved.",
          data: safeFeedbackView(feedback)
        };
      }

      if (!context.confirmed) {
        return createPendingToolAction(
          context,
          "resolve_customer_feedback",
          { feedbackId: String(feedback._id) },
          `Resolve the ${feedback.type.replace(/_/g, " ")} for order ${feedback.orderNumber}? The feedback will be kept in the record.`
        );
      }

      const resolved = await resolveCustomerFeedback(
        context.restaurantId,
        String(feedback._id),
        context.sender.normalizedPhone
      );

      return {
        success: true,
        message: resolved.idempotent
          ? "That feedback was already resolved."
          : "Customer feedback marked as resolved.",
        data: safeFeedbackView(resolved.feedback)
      };
    }
  },
  get_sales_summary: {
    definition: {
      name: "get_sales_summary",
      description:
        "Owner/manager. Return today's completed-order revenue and best-selling completed-order menu item.",
      parameters: {}
    },
    roles: toolPermissions.get_sales_summary,
    schema: emptySchema,
    handler: async (_args, context) => {
      const period = getCurrentDailySummaryPeriod(
        new Date(),
        context.restaurant.timezone
      );
      const metrics = await getOwnerSummaryMetrics({
        restaurantId: context.restaurantId,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        timezone: period.timezone,
        periodType: period.type
      });

      return {
        success: true,
        message: "Sales summary retrieved successfully.",
        data: {
          ...metrics,
          revenue: metrics.completedRevenue,
          bestSellingItem: metrics.topSellingItems[0]
        }
      };
    }
  },
  get_latest_customer_order: {
    definition: {
      name: "get_latest_customer_order",
      description:
        "Customer-only. Return the latest order for the current customer in this restaurant.",
      parameters: {}
    },
    roles: toolPermissions.get_latest_customer_order,
    schema: emptySchema,
    handler: async (_args, context) => {
      const order = await Order.findOne({
        restaurantId: context.restaurantId,
        customerPhone: context.sender.normalizedPhone
      }).sort({ createdAt: -1 });

      if (!order) {
        return {
          success: false,
          code: "ORDER_NOT_FOUND",
          message: "I could not find any orders for this customer."
        };
      }

      return {
        success: true,
        message: "Latest order retrieved successfully.",
        data: safeOrderView(order)
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
      const period = getCurrentDailySummaryPeriod(
        new Date(),
        context.restaurant.timezone
      );
      const metrics = await getOwnerSummaryMetrics({
        restaurantId: context.restaurantId,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        timezone: period.timezone,
        periodType: period.type
      });
      const unavailableItems = await MenuItem.countDocuments({
        restaurantId: context.restaurantId,
        isAvailable: false
      });

      return {
        success: true,
        message: "Business summary retrieved successfully.",
        data: {
          todayOrderCount: metrics.totalOrders,
          todayRevenue: metrics.completedRevenue,
          pendingOrders: metrics.countsByStatus.pending,
          unavailableItems
        }
      };
    }
  },
  create_campaign_draft: {
    definition: {
      name: "create_campaign_draft",
      description:
        "Owner/manager only. Store a campaign draft with bounded targeting and prepare an approval preview. This never sends customer messages before explicit confirmation.",
      parameters: {
        name: "Campaign name.",
        message: "Final campaign wording.",
        campaignType:
          "promotion | inactivity_reengagement | holiday | announcement",
        targeting:
          "Strict targeting rule: all_eligible_customers, inactive_customers, returning_customers, ordered_menu_item, or last_order_date_range.",
        scheduledAt:
          "Optional ISO or restaurant-local date-time.",
        referencedMenuItemId:
          "Optional restaurant menu item explicitly referenced by the campaign message."
      }
    },
    roles: toolPermissions.create_campaign_draft,
    sensitive: true,
    schema: createCustomerCampaignDraftSchema,
    handler: async (args, context) => {
      if (
        context.sender.role !== "owner" &&
        context.sender.role !== "manager"
      ) {
        return {
          success: false,
          code: "CAMPAIGN_FORBIDDEN",
          message:
            "Only a verified owner or manager can create a campaign."
        };
      }

      const { campaign, preview } =
        await createCustomerCampaignDraft({
          ...args,
          restaurantId: context.restaurantId,
          createdByPhone: context.sender.normalizedPhone,
          createdByRole: context.sender.role
        });
      const previewMessage = buildCustomerCampaignPreviewMessage(
        campaign,
        preview
      );
      const pending = await createPendingToolAction(
        context,
        "approve_campaign",
        {
          campaignId: String(campaign._id)
        },
        previewMessage
      );

      return {
        ...pending,
        data: {
          campaignId: String(campaign._id),
          status: campaign.status,
          preview: {
            targetingDescription: preview.targetingDescription,
            estimatedEligibleRecipients:
              preview.estimatedEligibleRecipients,
            excludedNoConsent: preview.excludedNoConsent,
            excludedOptOut: preview.excludedOptOut,
            excludedInvalidPhone: preview.excludedInvalidPhone,
            plannedSend:
              campaign.scheduledAt?.toISOString() ?? null,
            timezone: campaign.timezone
          }
        }
      };
    }
  },
  preview_campaign: {
    definition: {
      name: "preview_campaign",
      description:
        "Owner/manager only. Recalculate a campaign preview from bounded backend targeting without sending it.",
      parameters: {
        campaignId: "Campaign ID."
      }
    },
    roles: toolPermissions.preview_campaign,
    schema: campaignIdSchema,
    handler: async (args, context) => {
      const { campaign, preview } = await previewCustomerCampaign(
        context.restaurantId,
        args.campaignId
      );

      return {
        success: true,
        message: buildCustomerCampaignPreviewMessage(
          campaign,
          preview
        ),
        data: {
          campaignId: String(campaign._id),
          status: campaign.status,
          preview
        }
      };
    }
  },
  approve_campaign: {
    definition: {
      name: "approve_campaign",
      description:
        "Owner/manager only. Prepare or confirm campaign approval. Approval snapshots eligible recipients; delivery remains scheduled through the outbound queue.",
      parameters: {
        campaignId: "Campaign ID."
      }
    },
    roles: toolPermissions.approve_campaign,
    sensitive: true,
    schema: approveCampaignSchema,
    handler: async (args, context) => {
      if (!context.confirmed) {
        const { campaign, preview } =
          await previewCustomerCampaign(
            context.restaurantId,
            args.campaignId
          );

        return createPendingToolAction(
          context,
          "approve_campaign",
          {
            campaignId: args.campaignId,
            expectedCampaignVersion: campaign.campaignVersion
          },
          buildCustomerCampaignPreviewMessage(campaign, preview)
        );
      }

      const campaign = await approveCustomerCampaign(
        context.restaurantId,
        args.campaignId,
        context.sender.normalizedPhone,
        new Date(),
        {
          expectedCampaignVersion: args.expectedCampaignVersion
        }
      );

      return {
        success: true,
        message:
          campaign.status === "scheduled"
            ? "Campaign approved and scheduled."
            : "Campaign approved for queue delivery.",
        data: {
          campaignId: String(campaign._id),
          status: campaign.status,
          totalRecipientCount: campaign.totalRecipientCount,
          scheduledAt: campaign.scheduledAt
        }
      };
    }
  },
  cancel_campaign: {
    definition: {
      name: "cancel_campaign",
      description:
        "Owner/manager only. Prepare or confirm cancelling a campaign and all unsent recipients.",
      parameters: {
        campaignId: "Campaign ID."
      }
    },
    roles: toolPermissions.cancel_campaign,
    sensitive: true,
    schema: campaignIdSchema,
    handler: async (args, context) => {
      if (!context.confirmed) {
        return createPendingToolAction(
          context,
          "cancel_campaign",
          args,
          "Should I cancel this campaign and all of its unsent promotional messages?"
        );
      }

      const campaign = await cancelCustomerCampaign(
        context.restaurantId,
        args.campaignId,
        context.sender.normalizedPhone
      );

      return {
        success: true,
        message: "Campaign cancelled.",
        data: {
          campaignId: String(campaign._id),
          status: campaign.status
        }
      };
    }
  },
  list_campaigns: {
    definition: {
      name: "list_campaigns",
      description:
        "Owner/manager only. List this restaurant's campaigns using bounded status/type filters.",
      parameters: {
        status: "Optional controlled campaign status.",
        campaignType: "Optional controlled campaign type.",
        limit: "Optional result limit, maximum 25."
      }
    },
    roles: toolPermissions.list_campaigns,
    schema: listCustomerCampaignsSchema,
    handler: async (args, context) => {
      const campaigns = await listCustomerCampaigns(
        context.restaurantId,
        args
      );

      return {
        success: true,
        message: "Campaigns retrieved.",
        data: campaigns.map((campaign) => ({
          id: String(campaign._id),
          name: campaign.name,
          campaignType: campaign.campaignType,
          status: campaign.status,
          scheduledAt: campaign.scheduledAt,
          estimatedRecipientCount:
            campaign.estimatedRecipientCount,
          totalRecipientCount: campaign.totalRecipientCount,
          sentRecipientCount: campaign.sentRecipientCount,
          failedRecipientCount: campaign.failedRecipientCount,
          cancelledRecipientCount:
            campaign.cancelledRecipientCount,
          createdAt: campaign.createdAt
        }))
      };
    }
  },
  add_menu_items: {
    definition: {
      name: "add_menu_items",
      description:
        "Prepare or confirm adding one or more menu items. ONLY call this tool when the owner has explicitly provided the exact item name, price in GHS, and category for every item being added. Never guess, infer, or suggest specific item names, prices, or categories — if any detail is missing, ask the owner for it first before calling this tool. Creates menu categories by name when needed. Requires owner confirmation.",
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
  start_menu_item_image_upload: {
    definition: {
      name: "start_menu_item_image_upload",
      description:
        "Start a trusted menu-item image upload workflow. Provide a menu item when known, or omit it when the owner wants to upload first and identify the item afterward.",
      parameters: {
        itemName: "Menu item name (optional if itemId provided).",
        itemId: "Optional menu item ID."
      }
    },
    roles: toolPermissions.start_menu_item_image_upload,
    schema: startMenuItemImageUploadSchema,
    handler: async (args, context) => {
      if (!args.itemName && !args.itemId) {
        return logImageWorkflowToolResult(
          "start_menu_item_image_upload",
          context,
          await startMenuItemImageUpload({
            restaurantId: context.restaurantId,
            senderPhone: context.sender.normalizedPhone,
            senderRole: context.sender.role
          }),
          "awaiting_image"
        );
      }

      const item = await findMenuItemForRestaurant(context, args);

      if ("success" in item) {
        return item;
      }

      return logImageWorkflowToolResult(
        "start_menu_item_image_upload",
        context,
        await startMenuItemImageUpload({
          restaurantId: context.restaurantId,
          senderPhone: context.sender.normalizedPhone,
          senderRole: context.sender.role,
          itemId: String(item._id),
          itemName: item.name
        }),
        "awaiting_image"
      );
    }
  },
  assign_pending_image_to_menu_item: {
    definition: {
      name: "assign_pending_image_to_menu_item",
      description:
        "Select or retarget the menu item for one exact trusted pending image. Requires the pendingActionId from staff operational state and a menu item name or ID.",
      parameters: {
        pendingActionId: "Exact pending image action ID from staff operational state.",
        itemName: "Menu item name (optional if itemId provided).",
        itemId: "Optional menu item ID."
      }
    },
    roles: toolPermissions.assign_pending_image_to_menu_item,
    sensitive: true,
    schema: pendingImageAssignmentSchema,
    handler: async (args, context) => {
      const item = await findMenuItemForRestaurant(context, args);

      if ("success" in item) {
        return item;
      }

      return logImageWorkflowToolResult(
        "assign_pending_image_to_menu_item",
        context,
        await assignPendingImageToMenuItem({
          restaurantId: context.restaurantId,
          senderPhone: context.sender.normalizedPhone,
          senderRole: context.sender.role,
          pendingActionId: args.pendingActionId,
          itemId: String(item._id),
          itemName: item.name
        }),
        "awaiting_confirmation",
        args.pendingActionId
      );
    }
  },
  confirm_pending_image_assignment: {
    definition: {
      name: "confirm_pending_image_assignment",
      description:
        "Confirm one exact pending image assignment using its pendingActionId from staff operational state. The backend reads and applies the trusted uploaded media.",
      parameters: {
        pendingActionId: "Exact pending image action ID from staff operational state."
      }
    },
    roles: toolPermissions.confirm_pending_image_assignment,
    sensitive: true,
    schema: pendingImageActionSchema,
    handler: async (args, context) =>
      logImageWorkflowToolResult(
        "confirm_pending_image_assignment",
        context,
        await confirmPendingMenuItemImage({
          restaurantId: context.restaurantId,
          senderPhone: context.sender.normalizedPhone,
          senderRole: context.sender.role,
          pendingActionId: args.pendingActionId
        }),
        "completed",
        args.pendingActionId
      )
  },
  cancel_pending_image_assignment: {
    definition: {
      name: "cancel_pending_image_assignment",
      description:
        "Cancel one exact pending image assignment using its pendingActionId from staff operational state.",
      parameters: {
        pendingActionId: "Exact pending image action ID from staff operational state."
      }
    },
    roles: toolPermissions.cancel_pending_image_assignment,
    sensitive: true,
    schema: pendingImageActionSchema,
    handler: async (args, context) =>
      logImageWorkflowToolResult(
        "cancel_pending_image_assignment",
        context,
        await cancelPendingMenuItemImageConfirmation({
          restaurantId: context.restaurantId,
          senderPhone: context.sender.normalizedPhone,
          senderRole: context.sender.role,
          pendingActionId: args.pendingActionId
        }),
        "cancelled",
        args.pendingActionId
      )
  },
  remove_menu_item_image: {
    definition: {
      name: "remove_menu_item_image",
      description:
        "Remove the image from a menu item. Requires owner/manager confirmation.",
      parameters: {
        itemName: "Menu item name (optional if itemId provided).",
        itemId: "Optional menu item ID."
      }
    },
    roles: toolPermissions.remove_menu_item_image,
    sensitive: true,
    schema: menuItemLookupSchema,
    handler: async (args, context) => {
      const item = await findMenuItemForRestaurant(context, args);

      if ("success" in item) {
        return item;
      }

      if (!item.imageUrl) {
        return {
          success: false,
          code: "NO_IMAGE_TO_REMOVE",
          message: `${item.name} doesn't have an image set.`
        };
      }

      if (!context.confirmed) {
        return createPendingToolAction(
          context,
          "remove_menu_item_image",
          { itemId: String(item._id) },
          `Should I remove the image for ${item.name}?`
        );
      }

      const { deleteImageByUrl } = await import("../services/cloudinary.service");
      await deleteImageByUrl(item.imageUrl);

      const updated = await menuItemService.updateMenuItemImage(String(item._id), "");

      return {
        success: true,
        message: `✅ Image removed for ${updated.name}.`,
        data: {
          itemName: updated.name
        }
      };
    }
  },
  confirm_order: {
    definition: {
      name: "confirm_order",
      description:

        "Owner/manager only. Confirm that the restaurant accepts a pending customer-submitted order.",
      parameters: { orderReference: "Order number or order ID." }
    },
    roles: toolPermissions.confirm_order,
    schema: orderLookupSchema,
    handler: async (args, context) => {
      const order = await findOrderForRestaurant(context, args);

      if ("success" in order) {
        return order;
      }

      const result = await orderService.confirmRestaurantOrder(String(order._id));

      return {
        success: true,
        message: result.idempotent
          ? "Order was already confirmed."
          : "Order confirmed successfully. The customer will be notified.",
        data: {
          order: safeOrderView(result.order, true),
          orderEvent: "confirmed",
          notifyCustomer: true,
          receiptRequired: true,
          idempotent: result.idempotent
        }
      };
    }
  },
  reject_order: {
    definition: {
      name: "reject_order",
      description:
        "Owner/manager only. Reject a pending customer-submitted order when the restaurant cannot fulfil it.",
      parameters: {
        orderReference: "Order number or order ID.",
        reason: "Optional concise reason to share with the customer."
      }
    },
    roles: toolPermissions.reject_order,
    schema: rejectOrderSchema,
    handler: async (args, context) => {
      const order = await findOrderForRestaurant(context, args);

      if ("success" in order) {
        return order;
      }

      const result = await orderService.rejectRestaurantOrder(String(order._id), args.reason);

      return {
        success: true,
        message: result.idempotent
          ? "Order was already rejected."
          : "Order rejected. The customer will be notified.",
        data: {
          order: safeOrderView(result.order, true),
          orderEvent: "rejected",
          notifyCustomer: true,
          receiptRequired: false,
          idempotent: result.idempotent
        }
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
        data: {
          order: safeOrderView(result.order, true)
        }
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
        message: "Order submitted to the restaurant for confirmation.",
        data: {
          order: safeOrderView(order),
          orderEvent: "submitted",
          notifyOwner: true,
          receiptRequired: false
        }
      };
    }
  },
  start_order: {
    definition: {
      name: "start_order",
      description: "Start or resume the current customer's order draft.",
      parameters: {
        customerName: "Optional customer name to record on the draft."
      }
    },
    roles: toolPermissions.start_order,
    schema: startOrderSchema,
    handler: async (args, context) => {
      const draft = await getOrCreateDraft(
        context.restaurantId,
        context.sender.normalizedPhone,
        args.customerName
      );

      return {
        success: true,
        message:
          draft.cartItems.length > 0
            ? "Resumed the existing order draft."
            : `Started a new order draft for ${context.restaurant.name}.`,
        data: buildDraftView(draft, context.restaurant)
      };
    }
  },
  add_order_item_by_name: {
    definition: {
      name: "add_order_item_by_name",
      description:
        "Add a menu item to the order draft by name. Resolves the name to a real menu item server-side.",
      parameters: {
        itemName: "Menu item name as the customer said it.",
        quantity: "Optional quantity. The backend only accepts it when the customer message explicitly states the same quantity."
      }
    },
    roles: toolPermissions.add_order_item_by_name,
    schema: addOrderItemByNameSchema,
    handler: async (args, context) => {
      const draft = await getOrCreateDraft(context.restaurantId, context.sender.normalizedPhone);
      const explicitQuantity = resolveTrustedQuantity(
        args.quantity,
        context.originalMessage ?? args.itemName
      );
      const activeClarification = await findActiveOrderItemClarification({
        restaurantId: context.restaurantId,
        senderPhone: context.sender.normalizedPhone
      });

      if (activeClarification) {
        const resolved = await resolveOrderItemClarification(activeClarification, args.itemName);

        if (resolved.status === "matched") {
          const item = await MenuItem.findOne({
            _id: resolved.menuItemId,
            restaurantId: context.restaurantId,
            isAvailable: true
          });

          if (!item) {
            return {
              success: false,
              code: "MENU_ITEM_NOT_FOUND",
              message: "That menu item is no longer available."
            };
          }

          const displayName = getMenuItemDisplayName(
            item,
            resolved.candidate.categoryName ?? getMenuItemCategoryName(item)
          );
          const quantity = resolveTrustedQuantity(
            args.quantity,
            context.originalMessage ?? args.itemName,
            resolved.quantity
          );

          if (!quantity) {
            draft.pendingMenuItemId = item._id;
            draft.pendingMenuItemName = displayName;
            draft.currentStep = "collecting_quantity";
            clearPendingCategory(draft);
            await cancelPendingOrderItemClarifications({
              restaurantId: context.restaurantId,
              senderPhone: context.sender.normalizedPhone
            });
            await draft.save();

            return {
              success: false,
              code: "ORDER_ITEM_QUANTITY_REQUIRED",
              message: `Got it, ${displayName}. How many portions would you like?`,
              data: buildDraftView(draft, context.restaurant)
            };
          }

          (item as IMenuItemDocument & { categoryName?: string }).categoryName =
            resolved.candidate.categoryName ?? getMenuItemCategoryName(item);
          addItemToDraft(draft, item, quantity);
          clearPendingMenuItem(draft);
          clearPendingCategory(draft);
          draft.currentStep = "choosing_items";
          await draft.save();

          return {
            success: true,
            message: `Added ${quantity} x ${displayName} to the order draft.`,
            data: buildDraftView(draft, context.restaurant)
          };
        }

        return {
          success: false,
          code: resolved.status === "none" ? "ORDER_ITEM_CLARIFICATION_NO_MATCH" : "MULTIPLE_MENU_ITEMS_FOUND",
          message:
            resolved.status === "none"
              ? `Please choose one of these options: ${activeClarification.candidates
                  .map(getClarificationCandidateDisplayName)
                  .join(", ")}.`
              : `Please choose one option: ${resolved.matches
                  .map(getClarificationCandidateDisplayName)
                  .join(", ")}.`,
          data: {
            candidates: (resolved.status === "none"
              ? activeClarification.candidates
              : resolved.matches
            ).map((candidate) => ({
              name: getClarificationCandidateDisplayName(candidate),
              rawName: candidate.name,
              categoryId: candidate.categoryId ? String(candidate.categoryId) : undefined,
              categoryName: candidate.categoryName,
              price: candidate.price
            }))
          }
        };
      }

      if (draft.pendingCategoryId) {
        const categoryMatch = await findMenuItemMatchInCategory(
          context.restaurantId,
          String(draft.pendingCategoryId),
          args.itemName
        );

        if (categoryMatch.status === "matched") {
          const displayName = getMenuItemDisplayName(
            categoryMatch.item,
            getMenuItemCategoryName(categoryMatch.item) ?? draft.pendingCategoryName
          );
          if (!explicitQuantity) {
            draft.pendingMenuItemId = categoryMatch.item._id;
            draft.pendingMenuItemName = displayName;
            draft.currentStep = "collecting_quantity";
            clearPendingCategory(draft);
            await cancelPendingOrderItemClarifications({
              restaurantId: context.restaurantId,
              senderPhone: context.sender.normalizedPhone
            });
            await draft.save();

            return {
              success: false,
              code: "ORDER_ITEM_QUANTITY_REQUIRED",
              message: `Got it, ${displayName}. How many portions would you like?`,
              data: buildDraftView(draft, context.restaurant)
            };
          }

          addItemToDraft(draft, categoryMatch.item, explicitQuantity);
          clearPendingMenuItem(draft);
          clearPendingCategory(draft);
          draft.currentStep = "choosing_items";
          await cancelPendingOrderItemClarifications({
            restaurantId: context.restaurantId,
            senderPhone: context.sender.normalizedPhone
          });
          await draft.save();

          return {
            success: true,
            message: `Added ${explicitQuantity} x ${displayName} to the order draft.`,
            data: buildDraftView(draft, context.restaurant)
          };
        }

        if (categoryMatch.status === "multiple") {
          await createOrderItemClarification({
            restaurantId: context.restaurantId,
            senderPhone: context.sender.normalizedPhone,
            senderRole: context.sender.role,
            originalText: args.itemName,
            quantity: explicitQuantity ?? undefined,
            candidates: categoryMatch.matches.map((item) =>
              buildClarificationCandidate({
                menuItemId: item._id,
                name: item.name,
                categoryId: item.categoryId,
                categoryName: getMenuItemCategoryName(item) ?? draft.pendingCategoryName,
                price: item.price,
                available: item.isAvailable
              })
            )
          });

          return {
            success: false,
            code: "MULTIPLE_MENU_ITEMS_FOUND",
            message: categoryMatch.message,
            data: {
              candidates: categoryMatch.matches.map((item) => ({
                name: getMenuItemDisplayName(
                  item,
                  getMenuItemCategoryName(item) ?? draft.pendingCategoryName
                ),
                rawName: item.name,
                categoryId: String(item.categoryId),
                categoryName: getMenuItemCategoryName(item) ?? draft.pendingCategoryName,
                price: item.price
              }))
            }
          };
        }
      }

      const match = await findMenuItemMatch(context.restaurantId, args.itemName);

      if (match.status === "none") {
        return {
          success: false,
          code: "MENU_ITEM_NOT_FOUND",
          message: match.message
        };
      }

      if (match.status === "multiple") {
        await createOrderItemClarification({
          restaurantId: context.restaurantId,
          senderPhone: context.sender.normalizedPhone,
          senderRole: context.sender.role,
          originalText: args.itemName,
          quantity: explicitQuantity ?? undefined,
          candidates: match.matches.map((item) =>
            buildClarificationCandidate({
              menuItemId: item._id,
              name: item.name,
              categoryId: item.categoryId,
              categoryName: getMenuItemCategoryName(item),
              price: item.price,
              available: item.isAvailable
            })
          )
        });
        if (match.category) {
          draft.pendingCategoryId = new Types.ObjectId(match.category.id);
          draft.pendingCategoryName = match.category.name;
          draft.currentStep = "selecting_item_from_category";
          await draft.save();
        }

        return {
          success: false,
          code: "MULTIPLE_MENU_ITEMS_FOUND",
          message: match.message,
          data: {
            candidates: match.matches.map((item) => ({
              name: getMenuItemDisplayName(item, getMenuItemCategoryName(item)),
              rawName: item.name,
              categoryId: String(item.categoryId),
              categoryName: getMenuItemCategoryName(item),
              price: item.price
            }))
          }
        };
      }

      if (!explicitQuantity) {
        const displayName = getMenuItemDisplayName(match.item, getMenuItemCategoryName(match.item));
        draft.pendingMenuItemId = match.item._id;
        draft.pendingMenuItemName = displayName;
        draft.currentStep = "collecting_quantity";
        clearPendingCategory(draft);
        await cancelPendingOrderItemClarifications({
          restaurantId: context.restaurantId,
          senderPhone: context.sender.normalizedPhone
        });
        await draft.save();

        return {
          success: false,
          code: "ORDER_ITEM_QUANTITY_REQUIRED",
          message: `Sure. How many portions of ${displayName} would you like?`,
          data: buildDraftView(draft, context.restaurant)
        };
      }

      const quantity = explicitQuantity;
      const displayName = getMenuItemDisplayName(match.item, getMenuItemCategoryName(match.item));
      addItemToDraft(draft, match.item, quantity);
      clearPendingMenuItem(draft);
      draft.currentStep = "choosing_items";
      await cancelPendingOrderItemClarifications({
        restaurantId: context.restaurantId,
        senderPhone: context.sender.normalizedPhone
      });
      await draft.save();

      return {
        success: true,
        message: `Added ${quantity} x ${displayName} to the order draft.`,
        data: buildDraftView(draft, context.restaurant)
      };
    }
  },
  remove_order_item_by_name: {
    definition: {
      name: "remove_order_item_by_name",
      description: "Remove a menu item from the order draft by name.",
      parameters: {
        itemName: "Menu item name as the customer said it.",
        quantity: "Optional quantity to remove. If omitted, remove the line item."
      }
    },
    roles: toolPermissions.remove_order_item_by_name,
    schema: removeOrderItemByNameSchema,
    handler: async (args, context) => {
      const draft = await getOrCreateDraft(context.restaurantId, context.sender.normalizedPhone);
      const message = removeItemFromDraft(draft, args.itemName, args.quantity);
      clearPendingMenuItem(draft);
      await draft.save();

      return {
        success: true,
        message,
        data: buildDraftView(draft, context.restaurant)
      };
    }
  },
  update_order_item_quantity: {
    definition: {
      name: "update_order_item_quantity",
      description:
        "Set an exact new quantity for an item already in the order draft. Use this when the customer wants to change how many of something they ordered (e.g. from 2 to 5). This REPLACES the quantity — it does not add to it.",
      parameters: {
        itemName: "Name of the item in the cart to update.",
        newQuantity: "The exact new quantity the customer wants. Must be a positive integer."
      }
    },
    roles: toolPermissions.update_order_item_quantity,
    schema: updateOrderItemQuantitySchema,
    handler: async (args, context) => {
      const draft = await getOrCreateDraft(context.restaurantId, context.sender.normalizedPhone);

      if (draft.cartItems.length === 0) {
        return {
          success: false,
          code: "CART_EMPTY",
          message: "The order draft is empty. There are no items to update."
        };
      }

      const normalizedName = args.itemName.toLowerCase().trim();
      const matches = draft.cartItems.filter((item) => {
        const displayName = getCartItemDisplayName(item).toLowerCase();
        const rawName = item.name.toLowerCase();

        return (
          displayName.includes(normalizedName) ||
          normalizedName.includes(displayName) ||
          rawName.includes(normalizedName) ||
          normalizedName.includes(rawName)
        );
      });

      if (matches.length === 0) {
        return {
          success: false,
          code: "CART_ITEM_NOT_FOUND",
          message: `I couldn't find "${args.itemName}" in your order draft. Here is your current order:`,
          data: buildDraftView(draft, context.restaurant)
        };
      }

      if (matches.length > 1) {
        const names = matches.map(getCartItemDisplayName).join(", ");

        return {
          success: false,
          code: "MULTIPLE_CART_ITEMS_FOUND",
          message: `Multiple items matched "${args.itemName}". Please be more specific: ${names}.`,
          data: buildDraftView(draft, context.restaurant)
        };
      }

      const cartItem = matches[0];
      const displayName = getCartItemDisplayName(cartItem);
      const previousQuantity = cartItem.quantity;

      cartItem.quantity = args.newQuantity;
      cartItem.totalPrice = cartItem.unitPrice * args.newQuantity;

      clearConvertedDraftState(draft);
      await draft.save();

      return {
        success: true,
        message: `Updated ${displayName}: changed from ${previousQuantity} to ${args.newQuantity} portion${args.newQuantity === 1 ? "" : "s"}.`,
        data: buildDraftView(draft, context.restaurant)
      };
    }
  },
  update_order_draft: {
    definition: {
      name: "update_order_draft",
      description:
        "Update customer name, order type (pickup/delivery), and/or delivery address on the order draft. Call whenever the customer provides any of this, in any order.",
      parameters: {
        customerName: "Optional customer name.",
        orderType: "Optional: pickup or delivery.",
        deliveryAddress: "Optional delivery address, required if orderType is delivery."
      }
    },
    roles: toolPermissions.update_order_draft,
    schema: updateOrderDraftSchema,
    handler: async (args, context) => {
      const draft = await getOrCreateDraft(context.restaurantId, context.sender.normalizedPhone);

      if (args.orderType === "delivery" && !context.restaurant.deliveryEnabled) {
        return {
          success: false,
          code: "DELIVERY_NOT_AVAILABLE",
          message: "Delivery is not enabled for this restaurant. Offer pickup instead."
        };
      }

      if (args.customerName) {
        clearConvertedDraftState(draft);
        draft.customerName = args.customerName;
      }

      if (args.orderType) {
        clearConvertedDraftState(draft);
        draft.orderType = args.orderType;

        if (args.orderType === "pickup") {
          draft.deliveryAddress = undefined;
          draft.deliveryFee = 0;
          draft.deliveryFeeSource = "pickup";
          draft.deliveryFeeResolved = true;
        }
      }

      if (args.deliveryAddress) {
        clearConvertedDraftState(draft);
        draft.deliveryAddress = args.deliveryAddress;
      }

      if (draft.orderType === "delivery") {
        const subtotal = draft.cartItems.reduce((sum, item) => sum + item.totalPrice, 0);
        const fee = orderService.resolveDeliveryFee(
          context.restaurant,
          "delivery",
          draft.deliveryAddress,
          subtotal
        );

        draft.deliveryFee = fee.amount ?? undefined;
        draft.deliveryFeeSource = fee.source;
        draft.deliveryFeeResolved = fee.resolved;

        if (!fee.resolved) {
          draft.currentStep =
            fee.source === "manual_confirmation"
              ? draft.customerName?.trim()
                ? "confirming_order"
                : "collecting_name"
              : "awaiting_delivery_fee";
        }
      }

      await draft.save();

      return {
        success: true,
        code:
          draft.orderType === "delivery" && !draft.deliveryFeeResolved
            ? draft.deliveryFeeSource === "manual_confirmation"
              ? "DELIVERY_FEE_PENDING_CONFIRMATION"
              : "DELIVERY_FEE_NOT_CONFIGURED"
            : undefined,
        message:
          draft.orderType === "delivery" && !draft.deliveryFeeResolved
            ? draft.deliveryFeeSource === "manual_confirmation"
              ? "The delivery fee will be communicated by the restaurant or delivery rider after reviewing the location."
              : "The restaurant still needs to configure delivery pricing before I can submit the order."
            : "Order draft updated.",
        data: {
          ...buildDraftView(draft, context.restaurant),
          deliveryFeeStatus:
            draft.orderType === "delivery" && !draft.deliveryFeeResolved
              ? {
                  resolved: false,
                  source: draft.deliveryFeeSource,
                  requiresOwnerConfirmation: draft.deliveryFeeSource === "manual_confirmation"
                }
              : undefined
        }
      };
    }
  },
  get_order_draft: {
    definition: {
      name: "get_order_draft",
      description:
        "Read the current order draft: items, customer name, order type, address, totals, and which fields are still missing before it can be confirmed.",
      parameters: {}
    },
    roles: toolPermissions.get_order_draft,
    schema: emptySchema,
    handler: async (_args, context) => {
      const draft =
        (await findActiveDraft(context.restaurantId, context.sender.normalizedPhone)) ??
        (await getOrCreateDraft(context.restaurantId, context.sender.normalizedPhone));

      return {
        success: true,
        message:
          draft.cartItems.length > 0
            ? "Current order draft retrieved."
            : "The order draft is currently empty.",
        data: buildDraftView(draft, context.restaurant)
      };
    }
  },
  confirm_order_draft: {
    definition: {
      name: "confirm_order_draft",
      description:
        "Finalize the order draft into a real order. Requires items, order type, customer name, and (for delivery) a delivery address to already be set. Confirm the summary with the customer before calling this.",
      parameters: {}
    },
    roles: toolPermissions.confirm_order_draft,
    schema: emptySchema,
    handler: async (_args, context) => {
      const draft = await getOrCreateDraft(context.restaurantId, context.sender.normalizedPhone);

      if (draft.convertedOrderId) {
        const result = await submitOrderDraft(context.restaurant, context.sender.normalizedPhone);

        return {
          success: true,
          message: "Your order has already been submitted to the restaurant for confirmation.",
          data: {
            order: safeOrderView(result.order),
            orderEvent: "submitted",
            orderSubmitted: true,
            notifyOwner: true,
            receiptRequired: false,
            idempotent: true
          }
        };
      }

      const missingFields = getMissingDraftFields(draft);

      if (missingFields.length > 0) {
        return {
          success: false,
          code: getDraftMissingFieldCode(missingFields),
          message: missingFields.includes("customerName")
            ? "Before I submit your order, may I have your name please?"
            : `The order draft is missing: ${missingFields.join(", ")}.`,
          data: buildDraftView(draft, context.restaurant)
        };
      }

      let result: Awaited<ReturnType<typeof submitOrderDraft>>;

      try {
        result = await submitOrderDraft(context.restaurant, context.sender.normalizedPhone);
      } catch (error) {
        if (error instanceof BadRequestError) {
          return {
            success: false,
            code: error.code ?? "ORDER_DRAFT_INVALID",
            message: error.message,
            data: buildDraftView(draft, context.restaurant)
          };
        }

        throw error;
      }

      return {
        success: true,
        message: "Your order has been submitted to the restaurant for confirmation.",
        data: {
          order: safeOrderView(result.order),
          orderEvent: "submitted",
          orderSubmitted: true,
          notifyOwner: true,
          receiptRequired: false,
          idempotent: result.idempotent
        }
      };
    }
  },
  cancel_order_draft: {
    definition: {
      name: "cancel_order_draft",
      description: "Clear the current order draft without creating an order.",
      parameters: {}
    },
    roles: toolPermissions.cancel_order_draft,
    schema: emptySchema,
    handler: async (_args, context) => {
      const draft = await getOrCreateDraft(context.restaurantId, context.sender.normalizedPhone);
      resetDraftState(draft);
      clearConvertedDraftState(draft);
      await draft.save();

      return {
        success: true,
        message: "Order draft cleared."
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
        data: {
          order: safeOrderView(result.order, context.sender.role !== "customer")
        }
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
