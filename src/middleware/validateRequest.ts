import type { NextFunction, Request, Response } from "express";
import { z, type ZodError, type ZodSchema } from "zod";
import {
  orderStatuses,
  orderTypes,
  paymentMethods,
  paymentStatuses
} from "../models/order.model";
import { assistantTones, restaurantPlans, restaurantStatuses } from "../types/restaurant.types";

const phoneSchema = z.string().trim().min(7);
const optionalTextSchema = z.string().trim().min(1).optional();
const managerContactSchema = z
  .object({
    name: optionalTextSchema,
    phone: phoneSchema
  })
  .strict();

export const createRestaurantSchema = z
  .object({
    name: z.string().trim().min(1),
    ownerName: optionalTextSchema,
    ownerPhone: phoneSchema,
    contactEmail: z.string().trim().email().optional(),
    primaryCuisine: optionalTextSchema,
    managerPhones: z.array(phoneSchema).default([]),
    managerContacts: z.array(managerContactSchema).default([]),
    plan: z.enum(restaurantPlans).default("starter"),
    status: z.enum(restaurantStatuses).default("trial"),
    subscriptionRenewalDate: z.coerce.date().optional(),
    wasenderSessionId: z.string().trim().min(1),
    wasenderApiToken: optionalTextSchema,
    whatsappNumber: phoneSchema,
    openingHours: optionalTextSchema,
    pickupAddress: optionalTextSchema,
    deliveryEnabled: z.boolean().default(false),
    deliveryAreas: z.array(z.string().trim().min(1)).default([]),
    deliveryRadiusKm: z.number().min(0).optional(),
    minimumOrderValue: z.number().min(0).optional(),
    allowTakeaway: z.boolean().default(false),
    freeDeliveryThresholdEnabled: z.boolean().default(false),
    deliveryFeeNote: optionalTextSchema,
    assistantTone: z.enum(assistantTones).default("friendly"),
    assistantPersonalitySummary: optionalTextSchema,
    followUpEnabled: z.boolean().default(true),
    followUpDelayMinutes: z.number().int().min(0).default(5)
  })
  .strict();

export const updateRestaurantSchema = createRestaurantSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  {
    message: "At least one field is required"
  }
);

export const updateRestaurantStatusSchema = z
  .object({
    status: z.enum(restaurantStatuses)
  })
  .strict();

export const updateRestaurantPlanSchema = z
  .object({
    plan: z.enum(restaurantPlans)
  })
  .strict();

const stringArraySchema = z.array(z.string().trim().min(1)).default([]);

export const createMenuCategorySchema = z
  .object({
    name: z.string().trim().min(1),
    description: optionalTextSchema,
    sortOrder: z.number().int().min(0).optional(),
    isActive: z.boolean().default(true)
  })
  .strict();

export const updateMenuCategorySchema = createMenuCategorySchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  {
    message: "At least one field is required"
  }
);

export const reorderMenuCategoriesSchema = z
  .object({
    categoryOrders: z
      .array(
        z
          .object({
            categoryId: z.string().trim().min(1),
            sortOrder: z.number().int().min(0)
          })
          .strict()
      )
      .min(1)
  })
  .strict();

export const createMenuItemSchema = z
  .object({
    categoryId: z.string().trim().min(1),
    name: z.string().trim().min(1),
    description: optionalTextSchema,
    price: z.number().positive(),
    imageUrl: optionalTextSchema,
    isAvailable: z.boolean().default(true),
    preparationTimeMinutes: z.number().int().min(0).optional(),
    tags: stringArraySchema,
    allergens: stringArraySchema,
    portionSize: optionalTextSchema,
    isPopular: z.boolean().default(false),
    isPromoItem: z.boolean().default(false)
  })
  .strict();

export const updateMenuItemSchema = createMenuItemSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  {
    message: "At least one field is required"
  }
);

export const updateMenuItemAvailabilitySchema = z
  .object({
    isAvailable: z.boolean()
  })
  .strict();

export const agentOwnerMessageSchema = z
  .object({
    restaurantId: z.string().trim().min(1),
    senderPhone: phoneSchema,
    message: z.string().trim().min(1)
  })
  .strict();

export const createOrderSchema = z
  .object({
    customerName: optionalTextSchema,
    customerPhone: phoneSchema,
    items: z
      .array(
        z
          .object({
            menuItemId: z.string().trim().min(1),
            quantity: z.number().int().positive()
          })
          .strict()
      )
      .min(1),
    orderType: z.enum(orderTypes),
    deliveryAddress: optionalTextSchema,
    paymentMethod: z.enum(paymentMethods).default("unknown"),
    paymentStatus: z.enum(paymentStatuses).default("unpaid"),
    notes: optionalTextSchema
  })
  .strict();

export const updateOrderStatusSchema = z
  .object({
    status: z.enum(orderStatuses)
  })
  .strict();

export const agentCustomerMessageSchema = z
  .object({
    restaurantId: z.string().trim().min(1),
    customerPhone: phoneSchema,
    customerName: optionalTextSchema,
    message: z.string().trim().min(1)
  })
  .strict();

export const validateRequest =
  (schema: ZodSchema) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      const error = result.error as ZodError;
      res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: error.flatten()
      });
      return;
    }

    req.body = result.data;
    next();
  };
