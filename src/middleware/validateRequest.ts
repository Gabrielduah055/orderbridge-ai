import type { NextFunction, Request, Response } from "express";
import { z, type ZodError, type ZodSchema } from "zod";
import {
  orderStatuses,
  orderTypes,
  paymentMethods,
  paymentStatuses
} from "../models/order.model";
import {
  assistantTones,
  billingStatuses,
  ownerSummaryWeekdays,
  restaurantPlans,
  restaurantStatuses
} from "../types/restaurant.types";
import {
  agentChannels,
  businessCapabilities,
  businessStatuses,
  businessTypes
} from "../types/business.types";
import {
  isWhatsappPhoneAddress,
  normalizeGhanaPhone
} from "../utils/phone.util";

const phoneSchema = z.string().trim().min(7);
const businessPhoneSchema = z
  .string()
  .trim()
  .refine(isWhatsappPhoneAddress, "Phone must be a valid WhatsApp phone number")
  .transform(normalizeGhanaPhone);
const optionalTextSchema = z.string().trim().min(1).optional();
const ownerSummaryTimeSchema = z
  .string()
  .trim()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Time must use 24-hour HH:mm format");
const timezoneSchema = z.string().trim().min(1).refine(
  (value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  },
  {
    message: "Timezone must be a valid IANA timezone"
  }
);
const managerContactSchema = z
  .object({
    name: optionalTextSchema,
    phone: phoneSchema
  })
  .strict();
const deliveryPricingSchema = z
  .object({
    type: z.enum(["flat", "zone_based", "manual_confirmation"]),
    flatFee: z.number().min(0).optional(),
    freeDeliveryThreshold: z.number().min(0).optional(),
    zones: z
      .array(
        z
          .object({
            name: z.string().trim().min(1),
            aliases: z.array(z.string().trim().min(1)).default([]),
            fee: z.number().min(0)
          })
          .strict()
      )
      .default([])
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
    subscriptionAmount: z.number().min(0).optional(),
    billingStatus: z.enum(billingStatuses).optional(),
    wasenderSessionId: z.string().trim().min(1),
    wasenderApiToken: optionalTextSchema,
    whatsappNumber: phoneSchema,
    openingHours: optionalTextSchema,
    pickupAddress: optionalTextSchema,
    deliveryEnabled: z.boolean().default(false),
    deliveryAreas: z.array(z.string().trim().min(1)).default([]),
    deliveryRadiusKm: z.number().min(0).optional(),
    deliveryPricing: deliveryPricingSchema.optional(),
    minimumOrderValue: z.number().min(0).optional(),
    allowTakeaway: z.boolean().default(false),
    freeDeliveryThresholdEnabled: z.boolean().default(false),
    deliveryFeeNote: optionalTextSchema,
    assistantTone: z.enum(assistantTones).default("friendly"),
    assistantPersonalitySummary: optionalTextSchema,
    followUpEnabled: z.boolean().default(true),
    followUpDelayMinutes: z.number().int().min(0).default(3),
    timezone: timezoneSchema.default("Africa/Accra"),
    ownerDailySummaryEnabled: z.boolean().default(false),
    ownerDailySummaryTime: ownerSummaryTimeSchema.default("08:00"),
    ownerWeeklySummaryEnabled: z.boolean().default(false),
    ownerWeeklySummaryDay: z.enum(ownerSummaryWeekdays).default("monday"),
    ownerWeeklySummaryTime: ownerSummaryTimeSchema.default("08:00"),
    ownerPendingActionReminderEnabled: z.boolean().default(false),
    ownerPendingActionReminderDelayMinutes: z.number().int().min(1).default(3),
    orderCheckInEnabled: z.boolean().default(true),
    pickupCheckInDelayMinutes: z.number().int().min(1).default(45),
    deliveryCheckInDelayMinutes: z.number().int().min(1).default(75)
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

export const markSubscriptionPaidSchema = z
  .object({
    renewalDateOverride: z.coerce.date().optional()
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

export const updateCustomerPreferencesSchema = z
  .object({
    confirmed: z.literal(true),
    customerName: optionalTextSchema,
    preferredOrderType: z.enum(orderTypes).optional(),
    dietaryPreferences: z
      .array(z.string().trim().min(1).max(100))
      .max(25)
      .optional(),
    spicePreference: z.string().trim().min(1).max(100).nullable().optional(),
    marketingConsent: z.boolean().optional(),
    isOptedOut: z.boolean().optional()
  })
  .strict()
  .superRefine((value, context) => {
    const preferenceKeys = Object.keys(value).filter(
      (key) => key !== "confirmed"
    );

    if (preferenceKeys.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one confirmed customer preference is required"
      });
    }

    if (value.marketingConsent === true && value.isOptedOut === true) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Marketing consent and opt-out status cannot both be true",
        path: ["isOptedOut"]
      });
    }
  });

export const agentCustomerMessageSchema = z
  .object({
    restaurantId: z.string().trim().min(1),
    customerPhone: phoneSchema,
    customerName: optionalTextSchema,
    message: z.string().trim().min(1)
  })
  .strict();

export const websiteChatMessageSchema = z
  .object({
    conversationId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{43}$/, "conversationId must be an OrderBridge-issued identifier")
      .optional(),
    conversationToken: z
      .string()
      .trim()
      .regex(/^v1\.[A-Za-z0-9_-]{43}$/, "conversationToken is invalid")
      .optional(),
    message: z.string().trim().min(1).max(4_000)
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.conversationId) !== Boolean(value.conversationToken)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "conversationId and conversationToken must be supplied together",
        path: value.conversationId ? ["conversationToken"] : ["conversationId"]
      });
    }
  });

const commerceEventDateSchema = z
  .string()
  .trim()
  .datetime({ offset: true })
  .transform((value) => new Date(value));
const commerceEventTextSchema = (maximum: number) =>
  z.string().trim().min(1).max(maximum);
const commerceEventMoneySchema = z
  .number()
  .int()
  .min(0)
  .max(10_000_000_000_000);

const commercePaidOrderItemSchema = z
  .object({
    externalProductId: commerceEventTextSchema(160),
    name: commerceEventTextSchema(300),
    quantity: z.number().int().min(1).max(10_000),
    unitPricePesewas: commerceEventMoneySchema,
    lineTotalPesewas: commerceEventMoneySchema
  })
  .strict()
  .superRefine((item, context) => {
    const calculatedLineTotal = item.quantity * item.unitPricePesewas;
    if (
      !Number.isSafeInteger(calculatedLineTotal) ||
      item.lineTotalPesewas !== calculatedLineTotal
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lineTotalPesewas"],
        message: "lineTotalPesewas must equal quantity multiplied by unitPricePesewas"
      });
    }
  });

export const commercePaidOrderEventSchema = z
  .object({
    type: z.literal("order.paid"),
    eventId: commerceEventTextSchema(160),
    occurredAt: commerceEventDateSchema,
    order: z
      .object({
        externalOrderId: commerceEventTextSchema(160),
        orderNumber: commerceEventTextSchema(120),
        paymentReference: commerceEventTextSchema(200),
        paidAt: commerceEventDateSchema,
        currency: z.literal("GHS"),
        productPaymentTotalPesewas: commerceEventMoneySchema,
        items: z.array(commercePaidOrderItemSchema).min(1).max(100),
        customer: z
          .object({
            name: commerceEventTextSchema(200),
            phone: commerceEventTextSchema(32).refine(
              (value) => value.length >= 7,
              "Customer phone must contain at least 7 characters"
            ),
            email: z.string().trim().email().max(254).optional(),
            whatsappConsent: z.boolean()
          })
          .strict(),
        delivery: z
          .object({
            recipientName: commerceEventTextSchema(200).optional(),
            recipientPhone: commerceEventTextSchema(32).optional(),
            addressLine1: commerceEventTextSchema(300).optional(),
            addressLine2: commerceEventTextSchema(300).optional(),
            city: commerceEventTextSchema(120).optional(),
            region: commerceEventTextSchema(120).optional(),
            postalCode: commerceEventTextSchema(32).optional(),
            countryCode: z
              .string()
              .trim()
              .regex(/^[A-Z]{2}$/)
              .optional(),
            instructions: commerceEventTextSchema(1_000).optional(),
            chargeStatus: z.literal("to_be_arranged")
          })
          .strict()
      })
      .strict()
  })
  .strict()
  .superRefine((event, context) => {
    const itemTotal = event.order.items.reduce(
      (total, item) => total + item.lineTotalPesewas,
      0
    );

    if (
      !Number.isSafeInteger(itemTotal) ||
      itemTotal !== event.order.productPaymentTotalPesewas
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["order", "productPaymentTotalPesewas"],
        message: "productPaymentTotalPesewas must equal the sum of item line totals"
      });
    }
  });

const httpsUrlSchema = z.string().trim().url().refine(
  (value) => new URL(value).protocol === "https:",
  "HTTPS is required"
);
const commercePathSchema = z.string().trim().min(1).refine(
  (value) => value.startsWith("/") && !value.startsWith("//"),
  "Path must be origin-relative"
);

export const createBusinessSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    slug: z.string().trim().min(1).max(120).regex(/^[a-z0-9-]+$/).optional(),
    type: z.enum(businessTypes),
    status: z.enum(businessStatuses).default("trial"),
    restaurantId: z.string().trim().min(1).optional(),
    ownerName: optionalTextSchema,
    ownerEmail: z.string().trim().email().optional(),
    ownerPhone: businessPhoneSchema.optional(),
    staff: z
      .array(
        z
          .object({
            name: optionalTextSchema,
            phone: businessPhoneSchema.optional(),
            email: z.string().trim().email().optional(),
            role: z.enum(["owner", "manager"])
          })
          .strict()
      )
      .default([]),
    timezone: timezoneSchema.default("Africa/Accra"),
    enabledChannels: z.array(z.enum(agentChannels)).default([]),
    capabilities: z.array(z.enum(businessCapabilities)).default([]),
    agentInstructions: z.string().trim().min(1).max(4_000).optional(),
    websiteIntegration: z
      .object({
        enabled: z.boolean().default(false),
        integrationKey: z.string().trim().min(24).max(256).optional(),
        allowedOrigins: z.array(z.string().trim().url()).max(20).default([]),
        requestsPerMinute: z.number().int().min(1).max(600).default(60)
      })
      .strict()
      .optional(),
    whatsappIntegration: z
      .object({
        enabled: z.boolean().default(false),
        commerceNotificationsEnabled: z.boolean().default(false),
        wasenderSessionId: optionalTextSchema,
        wasenderApiToken: optionalTextSchema,
        whatsappNumber: businessPhoneSchema.optional()
      })
      .strict()
      .optional(),
    commerceIntegration: z
      .object({
        baseUrl: httpsUrlSchema,
        apiKey: z.string().trim().min(1).max(1_000),
        authType: z.enum(["bearer", "header"]).default("bearer"),
        apiKeyHeader: z.string().trim().regex(/^[A-Za-z0-9-]{1,80}$/).optional(),
        timeoutMs: z.number().int().min(500).max(15_000).default(5_000),
        paths: z
          .object({
            search: commercePathSchema,
            product: commercePathSchema.refine((value) => value.includes("{productId}"), {
              message: "Product path must include {productId}"
            }),
            availability: commercePathSchema.refine(
              (value) => value.includes("{productId}"),
              { message: "Availability path must include {productId}" }
            ),
            policies: commercePathSchema
          })
          .strict(),
        canonicalProductHosts: z.array(z.string().trim().min(1)).min(1).max(20)
      })
      .strict()
      .optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.type === "ecommerce" && !value.commerceIntegration) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["commerceIntegration"],
        message: "E-commerce businesses require commerceIntegration"
      });
    }
    if (value.websiteIntegration?.enabled && !value.enabledChannels.includes("website")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["enabledChannels"],
        message: "Website integration requires the website channel"
      });
    }
  });

const businessStaffContactSchema = z
  .object({
    name: optionalTextSchema,
    phone: businessPhoneSchema.optional(),
    email: z.string().trim().email().optional(),
    role: z.enum(["owner", "manager"])
  })
  .strict();

const updateWebsiteIntegrationSchema = z
  .object({
    enabled: z.boolean().optional(),
    allowedOrigins: z.array(z.string().trim().url()).max(20).optional(),
    requestsPerMinute: z.number().int().min(1).max(600).optional()
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one website integration field is required"
  });

const updateWhatsappIntegrationSchema = z
  .object({
    enabled: z.boolean().optional(),
    commerceNotificationsEnabled: z.boolean().optional(),
    wasenderSessionId: z.string().trim().min(1).max(500).optional(),
    wasenderApiToken: z.string().max(1_000).transform((value) => value.trim()).optional(),
    whatsappNumber: businessPhoneSchema.optional()
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one WhatsApp integration field is required"
  });

const updateCommercePathsSchema = z
  .object({
    search: commercePathSchema.optional(),
    product: commercePathSchema
      .refine((value) => value.includes("{productId}"), {
        message: "Product path must include {productId}"
      })
      .optional(),
    availability: commercePathSchema
      .refine((value) => value.includes("{productId}"), {
        message: "Availability path must include {productId}"
      })
      .optional(),
    policies: commercePathSchema.optional()
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one commerce path is required"
  });

const updateCommerceIntegrationSchema = z
  .object({
    baseUrl: httpsUrlSchema.optional(),
    apiKey: z.string().max(1_000).transform((value) => value.trim()).optional(),
    authType: z.enum(["bearer", "header"]).optional(),
    apiKeyHeader: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{1,80}$/)
      .optional(),
    paths: updateCommercePathsSchema.optional(),
    canonicalProductHosts: z
      .array(z.string().trim().min(1))
      .min(1)
      .max(20)
      .optional()
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one commerce integration field is required"
  });

export const updateBusinessSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    status: z.enum(businessStatuses).optional(),
    ownerName: optionalTextSchema,
    ownerEmail: z.string().trim().email().optional(),
    ownerPhone: businessPhoneSchema.optional(),
    staff: z.array(businessStaffContactSchema).optional(),
    timezone: timezoneSchema.optional(),
    agentInstructions: z.string().trim().min(1).max(4_000).optional(),
    websiteIntegration: updateWebsiteIntegrationSchema.optional(),
    whatsappIntegration: updateWhatsappIntegrationSchema.optional(),
    commerceIntegration: updateCommerceIntegrationSchema.optional()
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required"
  });

export const testCommerceConnectionSchema = z
  .object({
    searchTerm: z.string().trim().min(1).max(100)
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
