import { Types } from "mongoose";
import { Order, orderStatuses, type OrderStatus } from "../models/order.model";
import { StaffOrderQueryContext } from "../models/staffQueryContext.model";
import type { SenderRole } from "../types/agent.types";
import { BadRequestError } from "../utils/httpErrors";
import { normalizeWhatsappRecipient } from "../utils/phone.util";
import {
  businessReportPeriodTypes,
  resolveRequestedBusinessReportPeriod,
  type BusinessReportPeriodType
} from "./ownerSummary.service";

const DEFAULT_TIMEZONE = "Africa/Accra";
const CONTEXT_TTL_MS = 30 * 60_000;

export const orderListPeriodTypes = businessReportPeriodTypes;

export interface ListStaffOrdersInput {
  restaurantId: string;
  senderPhone: string;
  senderRole: Extract<SenderRole, "owner" | "manager">;
  originalMessage?: string;
  timezone?: string;
  period?: BusinessReportPeriodType;
  startDate?: string;
  endDate?: string;
  status?: OrderStatus;
  customerName?: string;
  customerPhone?: string;
  limit?: number;
  offset?: number;
  now?: Date;
}

export interface StaffOrderListItem {
  id: string;
  orderReference: string;
  status: OrderStatus;
  customerName: string;
  customerPhone: string;
  placedAt: string;
  placedAtFormatted: string;
  completedAt: string | null;
  completedAtFormatted: string | null;
  total: number;
}

export interface StaffOrderListResult {
  period: {
    type: string;
    label: string;
    start: string;
    end: string;
    timezone: string;
    retained: boolean;
  };
  filters: {
    status?: OrderStatus;
    customerName?: string;
    customerPhone?: string;
  };
  totalMatched: number;
  returnedCount: number;
  offset: number;
  truncated: boolean;
  nextOffset: number | null;
  orders: StaffOrderListItem[];
}

const normalizeDisplayText = (value: string): string =>
  value.trim().replace(/\s+/g, " ");

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const formatRestaurantDateTime = (
  value: Date,
  timezone = DEFAULT_TIMEZONE
): string => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).formatToParts(value);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  ) as Record<string, string>;
  const dayPeriod = values.dayPeriod?.toLowerCase().replace("am", "a.m.").replace("pm", "p.m.");

  return `${values.day} ${values.month} ${values.year} at ${values.hour}:${values.minute} ${dayPeriod}`;
};

const isFollowUpMessage = (message?: string): boolean => {
  if (!message) return false;
  const normalized = normalizeDisplayText(message).toLowerCase();
  if (
    /\b(?:remaining records?|next page|show more|more results?|continue)\b/.test(
      normalized
    )
  ) {
    return true;
  }
  return (
    /\b(?:who|which customers?|what time|when|what date|those|these|them|they|orders?|placed|made)\b/.test(
      normalized
    ) &&
    !/\b(?:today|yesterday|this week|last week|all time|since|between|from\s+\d|on\s+\d|new period)\b/.test(
      normalized
    )
  );
};

const loadRetainedContext = async (input: ListStaffOrdersInput) => {
  const isPaginationRequest = (input.offset ?? 0) > 0;
  if (!isPaginationRequest && !isFollowUpMessage(input.originalMessage)) {
    return null;
  }

  return StaffOrderQueryContext.findOne({
    restaurantId: input.restaurantId,
    senderPhone: input.senderPhone,
    senderRole: input.senderRole,
    expiresAt: { $gt: input.now ?? new Date() }
  });
};

const resolveCustomerFilter = async (input: {
  restaurantId: string;
  customerName?: string;
  customerPhone?: string;
}): Promise<{ customerName?: string; customerPhone?: string }> => {
  if (input.customerPhone) {
    const customerPhone = normalizeWhatsappRecipient(input.customerPhone);
    if (!customerPhone) {
      throw new BadRequestError("The customer phone is invalid.", "INVALID_CUSTOMER_IDENTITY");
    }

    const exists = await Order.exists({
      restaurantId: input.restaurantId,
      customerPhone
    });
    return exists ? { customerPhone } : { customerPhone };
  }

  if (!input.customerName) return {};
  if (!Types.ObjectId.isValid(input.restaurantId)) {
    throw new BadRequestError("Invalid restaurantId");
  }
  const customerName = normalizeDisplayText(input.customerName);
  const restaurantObjectId = new Types.ObjectId(input.restaurantId);
  const matchingCustomers = await Order.aggregate<{
    _id: string;
    names: string[];
  }>([
    {
      $match: {
        restaurantId: restaurantObjectId,
        customerName: {
          $regex: `^${escapeRegExp(customerName)}$`,
          $options: "i"
        }
      }
    },
    {
      $group: {
        _id: "$customerPhone",
        names: { $addToSet: "$customerName" }
      }
    },
    { $limit: 3 }
  ]);

  if (matchingCustomers.length > 1) {
    throw new BadRequestError(
      `More than one customer is saved as ${customerName}. Please clarify with the masked phone ending.`,
      "AMBIGUOUS_CUSTOMER"
    );
  }

  return matchingCustomers[0]
    ? {
        customerName,
        customerPhone: normalizeWhatsappRecipient(matchingCustomers[0]._id)
      }
    : { customerName, customerPhone: "__no_match__" };
};

export const rememberStaffOrderQueryContext = async (input: {
  restaurantId: string;
  senderPhone: string;
  senderRole: Extract<SenderRole, "owner" | "manager">;
  periodType: string;
  periodLabel: string;
  periodStart: Date;
  periodEnd: Date;
  timezone: string;
  status?: OrderStatus;
  customerName?: string;
  customerPhone?: string;
  now?: Date;
}): Promise<void> => {
  const now = input.now ?? new Date();
  await StaffOrderQueryContext.findOneAndUpdate(
    {
      restaurantId: input.restaurantId,
      senderPhone: input.senderPhone
    },
    {
      $set: {
        senderRole: input.senderRole,
        periodType: input.periodType,
        periodLabel: input.periodLabel,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        timezone: input.timezone,
        ...(input.status ? { status: input.status } : {}),
        ...(input.customerName ? { customerName: input.customerName } : {}),
        ...(input.customerPhone ? { customerPhone: input.customerPhone } : {}),
        expiresAt: new Date(now.getTime() + CONTEXT_TTL_MS)
      },
      $setOnInsert: { restaurantId: input.restaurantId, senderPhone: input.senderPhone },
      ...(!input.status || !input.customerName || !input.customerPhone
        ? {
            $unset: {
              ...(!input.status ? { status: "" } : {}),
              ...(!input.customerName ? { customerName: "" } : {}),
              ...(!input.customerPhone ? { customerPhone: "" } : {})
            }
          }
        : {})
    },
    { upsert: true, runValidators: true }
  );
};

export const listStaffOrders = async (
  input: ListStaffOrdersInput
): Promise<StaffOrderListResult> => {
  const now = input.now ?? new Date();
  const timezone = input.timezone || DEFAULT_TIMEZONE;
  const retained = await loadRetainedContext(input);
  const hasExplicitPeriod = Boolean(input.period || input.startDate || input.endDate);
  const period = hasExplicitPeriod
    ? await resolveRequestedBusinessReportPeriod({
        restaurantId: input.restaurantId,
        period: input.period ?? "custom",
        timezone,
        startDate: input.startDate,
        endDate: input.endDate,
        now
      })
    : retained
      ? {
          type: retained.periodType,
          label: retained.periodLabel,
          summaryType: "custom" as const,
          timezone: retained.timezone,
          periodStart: retained.periodStart,
          periodEnd: retained.periodEnd,
          key: `${retained.periodStart.toISOString()}_${retained.periodEnd.toISOString()}`
        }
      : await resolveRequestedBusinessReportPeriod({
          restaurantId: input.restaurantId,
          period: "all_time",
          timezone,
          now
        });
  const status = input.status ?? (retained?.status as OrderStatus | undefined);
  if (status && !orderStatuses.includes(status)) {
    throw new BadRequestError("The order status filter is invalid.");
  }
  const hasExplicitCustomerFilter =
    input.customerName !== undefined || input.customerPhone !== undefined;
  const customer = await resolveCustomerFilter({
    restaurantId: input.restaurantId,
    customerName: hasExplicitCustomerFilter
      ? input.customerName
      : retained?.customerName,
    customerPhone: hasExplicitCustomerFilter
      ? input.customerPhone
      : retained?.customerPhone
  });
  const query = {
    restaurantId: input.restaurantId,
    createdAt: { $gte: period.periodStart, $lt: period.periodEnd },
    ...(status ? { status } : {}),
    ...(customer.customerPhone
      ? { customerPhone: customer.customerPhone }
      : customer.customerName
        ? {
            customerName: {
              $regex: `^${escapeRegExp(customer.customerName)}$`,
              $options: "i"
            }
          }
        : {})
  };
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
  const offset = Math.max(input.offset ?? 0, 0);
  const [totalMatched, orders] = await Promise.all([
    Order.countDocuments(query),
    Order.find(query)
      .sort({ createdAt: 1, _id: 1 })
      .skip(offset)
      .limit(limit)
  ]);

  await rememberStaffOrderQueryContext({
    restaurantId: input.restaurantId,
    senderPhone: input.senderPhone,
    senderRole: input.senderRole,
    periodType: String(period.type),
    periodLabel: period.label,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    timezone: period.timezone,
    status,
    customerName: customer.customerName,
    customerPhone:
      customer.customerPhone === "__no_match__" ? undefined : customer.customerPhone,
    now
  });

  const returnedCount = orders.length;
  const nextOffset = offset + returnedCount < totalMatched
    ? offset + returnedCount
    : null;

  return {
    period: {
      type: String(period.type),
      label: period.label,
      start: period.periodStart.toISOString(),
      end: period.periodEnd.toISOString(),
      timezone: period.timezone,
      retained: !hasExplicitPeriod && Boolean(retained)
    },
    filters: {
      status,
      customerName: customer.customerName,
      customerPhone:
        customer.customerPhone === "__no_match__" ? undefined : customer.customerPhone
    },
    totalMatched,
    returnedCount,
    offset,
    truncated: nextOffset !== null,
    nextOffset,
    orders: orders.map((order) => ({
      id: String(order._id),
      orderReference: order.orderNumber || String(order._id),
      status: order.status,
      customerName: order.customerName || "Unknown customer",
      customerPhone: order.customerPhone,
      placedAt: order.createdAt.toISOString(),
      placedAtFormatted: formatRestaurantDateTime(order.createdAt, period.timezone),
      completedAt: order.completedAt?.toISOString() ?? null,
      completedAtFormatted: order.completedAt
        ? formatRestaurantDateTime(order.completedAt, period.timezone)
        : null,
      total: order.total
    }))
  };
};
