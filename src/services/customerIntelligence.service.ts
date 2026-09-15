import { Types } from "mongoose";
import { z } from "zod";
import { MenuItem } from "../models/MenuItem";
import {
  CustomerProfile,
  type ICustomerProfileDocument,
  type IFrequentlyOrderedItem
} from "../models/customerProfile.model";
import { BadRequestError } from "../utils/httpErrors";
import {
  isWhatsappPhoneAddress,
  normalizeGhanaPhone,
  normalizeWhatsappRecipient
} from "../utils/phone.util";
import { resolveZonedDateTime } from "../utils/zonedDateTime.util";
import { loadCompletedOrderPhonesForMenuItem } from "./customerCampaign.service";
import {
  classifyCustomerMarketingEligibility,
  type CustomerMarketingEligibility
} from "./customerMarketingPreference.service";
import {
  getCustomerMarketingStatus,
  maskCustomerPhone
} from "./customerProfile.service";

export const customerSegmentTypes = [
  "all_customers",
  "inactive_customers",
  "returning_customers",
  "ordered_menu_item",
  "last_order_date_range"
] as const;

export type CustomerSegmentType = (typeof customerSegmentTypes)[number];

export const customerInsightsSchema = z
  .object({
    customerName: z.string().trim().min(1).max(120).optional(),
    customerPhone: z.string().trim().min(1).max(40).optional()
  })
  .strict()
  .refine(
    (value) => Boolean(value.customerName || value.customerPhone),
    "Provide a customer name or phone number."
  );

export const customerSegmentInsightsSchema = z
  .object({
    segmentType: z.enum(customerSegmentTypes),
    inactiveDays: z.number().int().min(1).max(3650).optional(),
    menuItemName: z.string().trim().min(1).max(160).optional(),
    startDate: z.string().trim().min(1).optional(),
    endDate: z.string().trim().min(1).optional()
  })
  .strict()
  .superRefine((value, context) => {
    const allowed: Record<CustomerSegmentType, string[]> = {
      all_customers: [],
      inactive_customers: ["inactiveDays"],
      returning_customers: [],
      ordered_menu_item: ["menuItemName"],
      last_order_date_range: ["startDate", "endDate"]
    };

    for (const field of [
      "inactiveDays",
      "menuItemName",
      "startDate",
      "endDate"
    ] as const) {
      if (value[field] !== undefined && !allowed[value.segmentType].includes(field)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} is not allowed for ${value.segmentType}`
        });
      }
    }

    if (value.segmentType === "inactive_customers" && value.inactiveDays === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["inactiveDays"],
        message: "inactiveDays is required"
      });
    }
    if (value.segmentType === "ordered_menu_item" && !value.menuItemName) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["menuItemName"],
        message: "menuItemName is required"
      });
    }
    if (
      value.segmentType === "last_order_date_range" &&
      (!value.startDate || !value.endDate)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["startDate"],
        message: "startDate and endDate are required"
      });
    }
  });

const MAX_AMBIGUITY_CANDIDATES = 5;
export const MAX_SEGMENT_TOP_ITEMS = 10;

type IntelligenceProfile = Pick<
  ICustomerProfileDocument,
  | "customerPhone"
  | "customerName"
  | "orderCount"
  | "lastOrderAt"
  | "averageOrderValue"
  | "preferredOrderType"
  | "frequentlyOrderedItems"
  | "marketingConsent"
  | "isOptedOut"
  | "marketingConsentPromptedAt"
>;

const profileProjection = [
  "customerPhone",
  "customerName",
  "orderCount",
  "lastOrderAt",
  "averageOrderValue",
  "preferredOrderType",
  "frequentlyOrderedItems.menuItemId",
  "frequentlyOrderedItems.name",
  "frequentlyOrderedItems.orderCount",
  "frequentlyOrderedItems.totalQuantity",
  "frequentlyOrderedItems.lastOrderedAt",
  "marketingConsent",
  "isOptedOut",
  "marketingConsentPromptedAt"
].join(" ");

const ensureRestaurantId = (restaurantId: string): void => {
  if (!Types.ObjectId.isValid(restaurantId)) {
    throw new BadRequestError("Invalid restaurantId");
  }
};

const normalizeDisplayText = (value: string): string =>
  value.trim().replace(/\s+/g, " ");

const normalizeComparableText = (value: string): string =>
  normalizeDisplayText(value).toLocaleLowerCase("en");

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const exactNormalizedNameRegex = (value: string): RegExp =>
  new RegExp(
    `^${normalizeDisplayText(value).split(" ").map(escapeRegex).join("\\s+")}$`,
    "i"
  );

const roundCurrency = (value: number): number =>
  Math.round((value + Number.EPSILON) * 100) / 100;

const customerDisplayName = (profile: IntelligenceProfile): string => {
  const saved = profile.customerName
    ? normalizeDisplayText(profile.customerName)
    : "";
  return saved || `Customer ending ${maskCustomerPhone(profile.customerPhone).slice(-4)}`;
};

const safeCustomerSummary = (profile: IntelligenceProfile) => ({
  name: customerDisplayName(profile),
  maskedPhone: maskCustomerPhone(profile.customerPhone),
  orderCount: profile.orderCount
});

export type CustomerInsightsResult =
  | { status: "not_found"; found: false }
  | {
      status: "ambiguous";
      found: false;
      matchCount: number;
      candidates: Array<ReturnType<typeof safeCustomerSummary>>;
      truncated: boolean;
    }
  | {
      status: "found";
      found: true;
      customer: {
        name: string;
        maskedPhone: string;
        completedOrderCount: number;
        lastCompletedOrderAt: string | null;
        averageCompletedOrderValue: number;
        preferredOrderType: "pickup" | "delivery" | null;
        returning: boolean;
        marketingStatus: ReturnType<typeof getCustomerMarketingStatus>;
        frequentlyOrderedItems: Array<{
          name: string;
          orderCount: number;
          totalQuantity: number;
          lastOrderedAt: string;
        }>;
      };
    };

const buildCustomerInsights = (
  profile: IntelligenceProfile
): CustomerInsightsResult => ({
  status: "found",
  found: true,
  customer: {
    name: customerDisplayName(profile),
    maskedPhone: maskCustomerPhone(profile.customerPhone),
    completedOrderCount: profile.orderCount,
    lastCompletedOrderAt: profile.lastOrderAt?.toISOString() ?? null,
    averageCompletedOrderValue: roundCurrency(profile.averageOrderValue),
    preferredOrderType: profile.preferredOrderType ?? null,
    returning: profile.orderCount >= 2,
    marketingStatus: getCustomerMarketingStatus(profile),
    frequentlyOrderedItems: (profile.frequentlyOrderedItems ?? []).map((item) => ({
      name: normalizeDisplayText(item.name),
      orderCount: item.orderCount,
      totalQuantity: item.totalQuantity,
      lastOrderedAt: item.lastOrderedAt.toISOString()
    }))
  }
});

export const getCustomerInsights = async (input: {
  restaurantId: string;
  customerName?: string;
  customerPhone?: string;
}): Promise<CustomerInsightsResult> => {
  ensureRestaurantId(input.restaurantId);
  const parsed = customerInsightsSchema.parse({
    customerName: input.customerName,
    customerPhone: input.customerPhone
  });

  if (parsed.customerPhone) {
    const normalizedPhone = normalizeGhanaPhone(parsed.customerPhone);
    if (!isWhatsappPhoneAddress(normalizedPhone)) {
      throw new BadRequestError("customerPhone must be a valid phone number");
    }

    const profile = (await CustomerProfile.findOne({
      restaurantId: input.restaurantId,
      customerPhone: normalizedPhone
    }).select(profileProjection)) as IntelligenceProfile | null;

    if (
      !profile ||
      (parsed.customerName &&
        normalizeComparableText(customerDisplayName(profile)) !==
          normalizeComparableText(parsed.customerName))
    ) {
      return { status: "not_found", found: false };
    }

    return buildCustomerInsights(profile);
  }

  const nameFilter = {
    restaurantId: input.restaurantId,
    customerName: exactNormalizedNameRegex(parsed.customerName as string)
  };
  const [matchCount, profiles] = await Promise.all([
    CustomerProfile.countDocuments(nameFilter),
    CustomerProfile.find(nameFilter)
      .select(profileProjection)
      .sort({ orderCount: -1, lastOrderAt: -1, customerPhone: 1 })
      .limit(MAX_AMBIGUITY_CANDIDATES)
  ]);

  if (matchCount === 0 || profiles.length === 0) {
    return { status: "not_found", found: false };
  }

  if (matchCount > 1) {
    return {
      status: "ambiguous",
      found: false,
      matchCount,
      candidates: (profiles as IntelligenceProfile[]).map(safeCustomerSummary),
      truncated: matchCount > profiles.length
    };
  }

  return buildCustomerInsights(profiles[0] as IntelligenceProfile);
};

type DateRange = { start: Date; end: Date };

const incrementDateOnly = (value: string): string => {
  const [year, month, day] = value.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return next.toISOString().slice(0, 10);
};

const parseDateBoundary = (
  value: string,
  timezone: string,
  fieldName: string,
  endOfDay: boolean
): Date => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    resolveZonedDateTime(`${value}T00:00:00`, timezone, fieldName);
    const localDate = endOfDay ? incrementDateOnly(value) : value;
    const boundary = resolveZonedDateTime(
      `${localDate}T00:00:00`,
      timezone,
      fieldName
    ) as Date;
    return endOfDay ? new Date(boundary.getTime() - 1) : boundary;
  }

  const parsed = resolveZonedDateTime(value, timezone, fieldName);
  if (!parsed) {
    throw new BadRequestError(`Invalid ${fieldName}`);
  }
  return parsed;
};

const resolveDateRange = (
  startDate: string,
  endDate: string,
  timezone: string
): DateRange => {
  const start = parseDateBoundary(startDate, timezone, "startDate", false);
  const end = parseDateBoundary(endDate, timezone, "endDate", true);
  if (start > end) {
    throw new BadRequestError("endDate must be on or after startDate");
  }
  return { start, end };
};

type MenuItemCandidate = { _id: unknown; name: string };

const findMenuCandidates = async (
  restaurantId: string,
  menuItemName: string,
  exact: boolean
): Promise<MenuItemCandidate[]> => {
  const normalized = normalizeDisplayText(menuItemName);
  const name = exact
    ? exactNormalizedNameRegex(normalized)
    : new RegExp(escapeRegex(normalized), "i");
  return (await MenuItem.find({ restaurantId, name })
    .select("_id name")
    .sort({ name: 1, _id: 1 })
    .limit(MAX_AMBIGUITY_CANDIDATES + 1)) as MenuItemCandidate[];
};

const resolveMenuItemByName = async (
  restaurantId: string,
  menuItemName: string
): Promise<
  | { status: "not_found" }
  | { status: "ambiguous"; candidates: string[]; truncated: boolean }
  | { status: "found"; id: string; name: string }
> => {
  let candidates = await findMenuCandidates(restaurantId, menuItemName, true);
  if (candidates.length === 0) {
    candidates = await findMenuCandidates(restaurantId, menuItemName, false);
  }
  if (candidates.length === 0) {
    return { status: "not_found" };
  }
  if (candidates.length > 1) {
    return {
      status: "ambiguous",
      candidates: candidates
        .slice(0, MAX_AMBIGUITY_CANDIDATES)
        .map((item) => normalizeDisplayText(item.name)),
      truncated: candidates.length > MAX_AMBIGUITY_CANDIDATES
    };
  }
  return {
    status: "found",
    id: String(candidates[0]._id),
    name: normalizeDisplayText(candidates[0].name)
  };
};

interface TopItemAggregate {
  name: string;
  customerCount: number;
  orderCount: number;
  totalQuantity: number;
}

type WorkingTopItemAggregate = TopItemAggregate & {
  latestNameAt: number;
};

const aggregateTopItems = (
  profiles: IntelligenceProfile[]
): TopItemAggregate[] => {
  const aggregates = new Map<string, WorkingTopItemAggregate>();
  for (const profile of profiles) {
    const seen = new Set<string>();
    for (const item of profile.frequentlyOrderedItems ?? []) {
      const key = String(item.menuItemId);
      const existing = aggregates.get(key) ?? {
        name: normalizeDisplayText(item.name),
        customerCount: 0,
        orderCount: 0,
        totalQuantity: 0,
        latestNameAt: Number.NEGATIVE_INFINITY
      };
      const itemName = normalizeDisplayText(item.name);
      const itemNameAt = item.lastOrderedAt.getTime();
      if (
        itemNameAt > existing.latestNameAt ||
        (itemNameAt === existing.latestNameAt &&
          itemName.localeCompare(existing.name) < 0)
      ) {
        existing.name = itemName;
        existing.latestNameAt = itemNameAt;
      }
      if (!seen.has(key)) {
        existing.customerCount += 1;
        seen.add(key);
      }
      existing.orderCount += item.orderCount;
      existing.totalQuantity += item.totalQuantity;
      aggregates.set(key, existing);
    }
  }

  return Array.from(aggregates.values())
    .sort(
      (left, right) =>
        right.totalQuantity - left.totalQuantity ||
        right.orderCount - left.orderCount ||
        right.customerCount - left.customerCount ||
        left.name.localeCompare(right.name)
    )
    .slice(0, MAX_SEGMENT_TOP_ITEMS)
    .map(({ latestNameAt: _latestNameAt, ...item }) => item);
};

const eligibilityCounts = (profiles: IntelligenceProfile[]) => {
  const counts: Record<CustomerMarketingEligibility, number> = {
    eligible: 0,
    no_consent: 0,
    opted_out: 0,
    invalid_recipient: 0
  };
  const eligibleRecipients = new Set<string>();
  for (const profile of profiles) {
    const eligibility = classifyCustomerMarketingEligibility(profile);
    if (eligibility === "eligible") {
      eligibleRecipients.add(normalizeWhatsappRecipient(profile.customerPhone));
    } else {
      counts[eligibility] += 1;
    }
  }
  counts.eligible = eligibleRecipients.size;
  return counts;
};

export type CustomerSegmentInsightsResult =
  | {
      status: "menu_item_not_found";
      segmentType: "ordered_menu_item";
      menuItemName: string;
    }
  | {
      status: "ambiguous_menu_item";
      segmentType: "ordered_menu_item";
      candidates: string[];
      truncated: boolean;
    }
  | {
      status: "ok";
      segment: {
        type: CustomerSegmentType;
        inactiveDays?: number;
        menuItemName?: string;
        startDate?: string;
        endDate?: string;
      };
      totalCustomers: number;
      customersWithCompletedOrders: number;
      totalCompletedOrderCount: number;
      marketingEligibleCustomers: number;
      excludedNoConsent: number;
      excludedOptOut: number;
      excludedInvalidPhone: number;
      historicalTopItems: TopItemAggregate[];
      preferredOrderTypeDistribution: {
        pickup: number;
        delivery: number;
        unknown: number;
      };
    };

export const getCustomerSegmentInsights = async (input: {
  restaurantId: string;
  timezone: string;
  segmentType: CustomerSegmentType;
  inactiveDays?: number;
  menuItemName?: string;
  startDate?: string;
  endDate?: string;
  now?: Date;
}): Promise<CustomerSegmentInsightsResult> => {
  ensureRestaurantId(input.restaurantId);
  const parsed = customerSegmentInsightsSchema.parse({
    segmentType: input.segmentType,
    inactiveDays: input.inactiveDays,
    menuItemName: input.menuItemName,
    startDate: input.startDate,
    endDate: input.endDate
  });
  const filter: Record<string, unknown> = { restaurantId: input.restaurantId };
  let menuItem: { id: string; name: string } | undefined;

  if (parsed.segmentType === "inactive_customers") {
    filter.orderCount = { $gte: 1 };
    filter.lastOrderAt = {
      $lt: new Date(
        (input.now ?? new Date()).getTime() -
          (parsed.inactiveDays as number) * 86_400_000
      )
    };
  } else if (parsed.segmentType === "returning_customers") {
    filter.orderCount = { $gte: 2 };
  } else if (parsed.segmentType === "last_order_date_range") {
    const range = resolveDateRange(
      parsed.startDate as string,
      parsed.endDate as string,
      input.timezone
    );
    filter.lastOrderAt = { $gte: range.start, $lte: range.end };
  } else if (parsed.segmentType === "ordered_menu_item") {
    const resolution = await resolveMenuItemByName(
      input.restaurantId,
      parsed.menuItemName as string
    );
    if (resolution.status === "not_found") {
      return {
        status: "menu_item_not_found",
        segmentType: "ordered_menu_item",
        menuItemName: normalizeDisplayText(parsed.menuItemName as string)
      };
    }
    if (resolution.status === "ambiguous") {
      return {
        status: "ambiguous_menu_item",
        segmentType: "ordered_menu_item",
        candidates: resolution.candidates,
        truncated: resolution.truncated
      };
    }
    menuItem = resolution;
    const phones = await loadCompletedOrderPhonesForMenuItem(
      input.restaurantId,
      resolution.id
    );
    filter.customerPhone = { $in: Array.from(phones) };
  }

  const profiles = (await CustomerProfile.find(filter).select(
    profileProjection
  )) as IntelligenceProfile[];
  const eligibility = eligibilityCounts(profiles);
  const preferredOrderTypeDistribution = {
    pickup: 0,
    delivery: 0,
    unknown: 0
  };
  for (const profile of profiles) {
    if (profile.preferredOrderType === "pickup") {
      preferredOrderTypeDistribution.pickup += 1;
    } else if (profile.preferredOrderType === "delivery") {
      preferredOrderTypeDistribution.delivery += 1;
    } else {
      preferredOrderTypeDistribution.unknown += 1;
    }
  }

  return {
    status: "ok",
    segment: {
      type: parsed.segmentType,
      ...(parsed.inactiveDays !== undefined
        ? { inactiveDays: parsed.inactiveDays }
        : {}),
      ...(menuItem ? { menuItemName: menuItem.name } : {}),
      ...(parsed.startDate ? { startDate: parsed.startDate } : {}),
      ...(parsed.endDate ? { endDate: parsed.endDate } : {})
    },
    totalCustomers: profiles.length,
    customersWithCompletedOrders: profiles.filter((profile) => profile.orderCount >= 1).length,
    totalCompletedOrderCount: profiles.reduce(
      (total, profile) => total + profile.orderCount,
      0
    ),
    marketingEligibleCustomers: eligibility.eligible,
    excludedNoConsent: eligibility.no_consent,
    excludedOptOut: eligibility.opted_out,
    excludedInvalidPhone: eligibility.invalid_recipient,
    historicalTopItems: aggregateTopItems(profiles),
    preferredOrderTypeDistribution
  };
};
