import { Types } from "mongoose";
import { Order, orderStatuses, type OrderStatus } from "../models/order.model";
import {
  StaffOrderQueryContext,
  type IStaffOrderCustomerClarificationCandidate,
  type IStaffOrderQueryContextDocument
} from "../models/staffQueryContext.model";
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
const CUSTOMER_CLARIFICATION_TTL_MS = 10 * 60_000;

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
  customerIdentity: string;
  phoneEnding: string;
  placedAt: string;
  placedAtFormatted: string;
  completedAt: string | null;
  completedAtFormatted: string | null;
  total: number;
}

export interface StaffOrderListResult {
  kind: "order_list";
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
  };
  totalMatched: number;
  returnedCount: number;
  offset: number;
  truncated: boolean;
  nextOffset: number | null;
  orders: StaffOrderListItem[];
}

export interface StaffOrderCustomerClarificationCandidate {
  number: number;
  customerName: string;
  phoneEnding: string;
}

export interface StaffOrderCustomerClarificationResult {
  kind: "customer_clarification";
  code:
    | "CUSTOMER_CLARIFICATION_REQUIRED"
    | "CUSTOMER_CLARIFICATION_INVALID"
    | "CUSTOMER_CLARIFICATION_AMBIGUOUS"
    | "CUSTOMER_CLARIFICATION_EXPIRED";
  message: string;
  customerName?: string;
  candidates: StaffOrderCustomerClarificationCandidate[];
}

export type StaffOrderQueryResult =
  | StaffOrderListResult
  | StaffOrderCustomerClarificationResult;

const normalizeDisplayText = (value: string): string =>
  value.trim().replace(/\s+/g, " ");

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getPhoneEnding = (value: string): string =>
  value.replace(/\D/g, "").slice(-4);

const toSafeClarificationCandidates = (
  candidates: IStaffOrderCustomerClarificationCandidate[]
): StaffOrderCustomerClarificationCandidate[] =>
  candidates.map((candidate, index) => ({
    number: index + 1,
    customerName: candidate.customerName,
    phoneEnding: getPhoneEnding(candidate.customerPhone)
  }));

type CustomerClarificationSelection =
  | { type: "phone_ending"; value: string }
  | { type: "candidate_number"; value: number };

interface ContextualPhoneEndingSelection {
  selection: CustomerClarificationSelection;
  isLabeled: boolean;
}

const ordinalSelections = new Map([
  ["first", 1],
  ["second", 2],
  ["third", 3],
  ["fourth", 4],
  ["fifth", 5],
  ["sixth", 6],
  ["seventh", 7],
  ["eighth", 8],
  ["ninth", 9],
  ["tenth", 10]
]);

const parseCustomerClarificationSelection = (
  message?: string
): CustomerClarificationSelection | null => {
  if (!message) return null;
  const normalized = normalizeDisplayText(message).toLowerCase();
  const endingMatch = /\b(?:the\s+)?one\s+ending(?:\s+(?:in|with))?\s*(\d{4})\b/.exec(
    normalized
  );
  if (endingMatch) {
    return { type: "phone_ending", value: endingMatch[1] };
  }

  const numberedMatch =
    /^#?(\d{1,3})(?:st|nd|rd|th)?[.!?]?$/.exec(normalized) ??
    /^(?:the\s+)?(?:(?:one\s+)?(?:number|option|customer))\s*#?(\d{1,3})(?:st|nd|rd|th)?(?:\s+(?:one|customer))?\b/.exec(
      normalized
    );
  if (numberedMatch) {
    return { type: "candidate_number", value: Number(numberedMatch[1]) };
  }

  const ordinalMatch =
    /^(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)[.!?]?$/.exec(
      normalized
    ) ??
    /^(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(?:one|customer|option)\b/.exec(
      normalized
    );
  return ordinalMatch
    ? {
        type: "candidate_number",
        value: ordinalSelections.get(ordinalMatch[1]) as number
      }
    : null;
};

const parseContextualPhoneEndingSelection = (
  message?: string
): ContextualPhoneEndingSelection | null => {
  if (!message) return null;
  const normalized = normalizeDisplayText(message).toLowerCase();
  const labeledEndingMatch =
    /^(?:(?:phone\s+)?ending|ends?\s+with)\s+(\d{4})[.!?]?$/.exec(
      normalized
    );
  if (labeledEndingMatch) {
    return {
      selection: { type: "phone_ending", value: labeledEndingMatch[1] },
      isLabeled: true
    };
  }

  const bareEndingMatch = /^(\d{4})[.!?]?$/.exec(normalized);
  return bareEndingMatch
    ? {
        selection: { type: "phone_ending", value: bareEndingMatch[1] },
        isLabeled: false
      }
    : null;
};

const isCustomerClarificationSelectionMessage = (message?: string): boolean => {
  return (
    parseCustomerClarificationSelection(message) !== null ||
    parseContextualPhoneEndingSelection(message)?.isLabeled === true
  );
};

const isExplicitOrderQueryMessage = (message?: string): boolean => {
  if (!message) return false;
  const normalized = normalizeDisplayText(message).toLowerCase();
  return (
    /\b(?:remaining records?|next page|show more|more results?|continue)\b/.test(
      normalized
    ) ||
    /\b(?:show|list|find|get|display|give me)\b.*\borders?\b/.test(normalized) ||
    /\borders?\b.*\b(?:today|yesterday|this week|last week|all time|since|between|from)\b/.test(
      normalized
    )
  );
};

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

const loadCustomerClarificationContext = async (
  input: ListStaffOrdersInput
): Promise<IStaffOrderQueryContextDocument | null> => {
  return StaffOrderQueryContext.findOne({
    restaurantId: input.restaurantId,
    senderPhone: input.senderPhone,
    senderRole: input.senderRole
  });
};

const clearCustomerClarification = async (input: {
  restaurantId: string;
  senderPhone: string;
  senderRole: Extract<SenderRole, "owner" | "manager">;
}): Promise<void> => {
  await StaffOrderQueryContext.findOneAndUpdate(
    {
      restaurantId: input.restaurantId,
      senderPhone: input.senderPhone,
      senderRole: input.senderRole
    },
    { $unset: { customerClarification: "" } }
  );
};

type ResolvedCustomerFilter = {
  status: "resolved";
  customerName?: string;
  customerPhone?: string;
};

type AmbiguousCustomerFilter = {
  status: "ambiguous";
  customerName: string;
  candidates: IStaffOrderCustomerClarificationCandidate[];
};

const resolveCustomerFilter = async (input: {
  restaurantId: string;
  customerName?: string;
  customerPhone?: string;
}): Promise<ResolvedCustomerFilter | AmbiguousCustomerFilter> => {
  if (input.customerPhone) {
    const customerPhone = normalizeWhatsappRecipient(input.customerPhone);
    if (!customerPhone) {
      throw new BadRequestError("The customer phone is invalid.", "INVALID_CUSTOMER_IDENTITY");
    }

    await Order.exists({
      restaurantId: input.restaurantId,
      customerPhone
    });
    return { status: "resolved", customerPhone };
  }

  if (!input.customerName) return { status: "resolved" };
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
    }
  ]);

  const uniqueCustomers = Array.from(
    matchingCustomers.reduce((customers, match) => {
      const customerPhone = normalizeWhatsappRecipient(match._id);
      if (customerPhone && !customers.has(customerPhone)) {
        customers.set(customerPhone, {
          customerName: normalizeDisplayText(match.names[0] || customerName),
          customerPhone
        });
      }
      return customers;
    }, new Map<string, IStaffOrderCustomerClarificationCandidate>()).values()
  );

  if (uniqueCustomers.length > 1) {
    return {
      status: "ambiguous",
      customerName,
      candidates: uniqueCustomers
    };
  }

  return uniqueCustomers[0]
    ? {
        status: "resolved",
        customerName,
        customerPhone: uniqueCustomers[0].customerPhone
      }
    : {
        status: "resolved",
        customerName,
        customerPhone: "__no_match__"
      };
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
  customerClarification?: {
    customerName: string;
    candidates: IStaffOrderCustomerClarificationCandidate[];
  };
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
        ...(input.customerClarification
          ? {
              customerClarification: {
                ...input.customerClarification,
                expiresAt: new Date(
                  now.getTime() + CUSTOMER_CLARIFICATION_TTL_MS
                )
              }
            }
          : {}),
        expiresAt: new Date(now.getTime() + CONTEXT_TTL_MS)
      },
      $setOnInsert: { restaurantId: input.restaurantId, senderPhone: input.senderPhone },
      ...(
        !input.status ||
        !input.customerName ||
        !input.customerPhone ||
        !input.customerClarification
          ? {
              $unset: {
                ...(!input.status ? { status: "" } : {}),
                ...(!input.customerName ? { customerName: "" } : {}),
                ...(!input.customerPhone ? { customerPhone: "" } : {}),
                ...(!input.customerClarification
                  ? { customerClarification: "" }
                  : {})
              }
            }
          : {}
      )
    },
    { upsert: true, runValidators: true }
  );
};

export const listStaffOrders = async (
  input: ListStaffOrdersInput
): Promise<StaffOrderQueryResult> => {
  const now = input.now ?? new Date();
  const timezone = input.timezone || DEFAULT_TIMEZONE;
  const hasExplicitCustomerFilter =
    input.customerName !== undefined || input.customerPhone !== undefined;
  const directClarificationSelection = hasExplicitCustomerFilter
    ? null
    : parseCustomerClarificationSelection(input.originalMessage);
  const contextualPhoneEndingSelection = hasExplicitCustomerFilter
    ? null
    : parseContextualPhoneEndingSelection(input.originalMessage);
  const hasExplicitOrderQuery =
    Boolean(
      input.period ||
      input.startDate ||
      input.endDate ||
      input.status ||
      input.limit !== undefined ||
      input.offset !== undefined
    ) || isExplicitOrderQueryMessage(input.originalMessage);
  const shouldInspectClarification =
    !hasExplicitCustomerFilter &&
    (directClarificationSelection !== null ||
      contextualPhoneEndingSelection !== null ||
      !hasExplicitOrderQuery);
  const clarificationContext = shouldInspectClarification
    ? await loadCustomerClarificationContext(input)
    : null;
  const clarificationSelection =
    directClarificationSelection ??
    (clarificationContext?.customerClarification
      ? contextualPhoneEndingSelection?.selection ?? null
      : null);
  const clarificationSelectionRequested =
    !hasExplicitCustomerFilter &&
    (isCustomerClarificationSelectionMessage(input.originalMessage) ||
      Boolean(clarificationContext?.customerClarification));
  const retained = clarificationSelectionRequested
    ? clarificationContext
    : await loadRetainedContext(input);
  let selectedCustomer:
    | IStaffOrderCustomerClarificationCandidate
    | undefined;

  if (clarificationSelectionRequested) {
    const clarification = clarificationContext?.customerClarification;
    const contextExpiresAt = clarificationContext?.expiresAt?.getTime();
    const clarificationExpiresAt = clarification?.expiresAt?.getTime();
    const clarificationExpired =
      !clarification ||
      !contextExpiresAt ||
      contextExpiresAt <= now.getTime() ||
      !clarificationExpiresAt ||
      clarificationExpiresAt <= now.getTime();

    if (clarificationExpired) {
      if (clarificationContext?.customerClarification) {
        await clearCustomerClarification(input);
      }
      return {
        kind: "customer_clarification",
        code: "CUSTOMER_CLARIFICATION_EXPIRED",
        message:
          "That customer choice is no longer active. Please repeat the customer name and order filters.",
        candidates: []
      };
    }

    const selection = clarificationSelection;
    const candidates = clarification.candidates;
    if (!selection) {
      return {
        kind: "customer_clarification",
        code: "CUSTOMER_CLARIFICATION_INVALID",
        message:
          "I could not match that choice. Please reply with a candidate number or one of the displayed phone endings.",
        customerName: clarification.customerName,
        candidates: toSafeClarificationCandidates(candidates)
      };
    }

    if (selection.type === "candidate_number") {
      selectedCustomer = candidates[selection.value - 1];
    } else {
      const endingMatches = candidates.filter(
        (candidate) => getPhoneEnding(candidate.customerPhone) === selection.value
      );
      if (endingMatches.length > 1) {
        return {
          kind: "customer_clarification",
          code: "CUSTOMER_CLARIFICATION_AMBIGUOUS",
          message:
            "That phone ending matches more than one customer. Please choose a candidate number.",
          customerName: clarification.customerName,
          candidates: toSafeClarificationCandidates(candidates)
        };
      }
      selectedCustomer = endingMatches[0];
    }

    if (!selectedCustomer) {
      return {
        kind: "customer_clarification",
        code: "CUSTOMER_CLARIFICATION_INVALID",
        message:
          "That selection does not match the available customers. Please reply with a listed candidate number or phone ending.",
        customerName: clarification.customerName,
        candidates: toSafeClarificationCandidates(candidates)
      };
    }
  }

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
  const customer = selectedCustomer
    ? {
        status: "resolved" as const,
        customerName: selectedCustomer.customerName,
        customerPhone: selectedCustomer.customerPhone
      }
    : await resolveCustomerFilter({
        restaurantId: input.restaurantId,
        customerName: hasExplicitCustomerFilter
          ? input.customerName
          : retained?.customerName,
        customerPhone: hasExplicitCustomerFilter
          ? input.customerPhone
          : retained?.customerPhone
      });

  if (customer.status === "ambiguous") {
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
      customerClarification: {
        customerName: customer.customerName,
        candidates: customer.candidates
      },
      now
    });
    return {
      kind: "customer_clarification",
      code: "CUSTOMER_CLARIFICATION_REQUIRED",
      message: `More than one customer is saved as ${customer.customerName}. Please choose a candidate number or phone ending.`,
      customerName: customer.customerName,
      candidates: toSafeClarificationCandidates(customer.candidates)
    };
  }

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
  const customerIdentities = new Map<string, string>();
  for (const order of orders) {
    const customerPhone = normalizeWhatsappRecipient(order.customerPhone);
    if (customerPhone && !customerIdentities.has(customerPhone)) {
      customerIdentities.set(
        customerPhone,
        `customer-${customerIdentities.size + 1}`
      );
    }
  }

  return {
    kind: "order_list",
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
      customerName: customer.customerName
    },
    totalMatched,
    returnedCount,
    offset,
    truncated: nextOffset !== null,
    nextOffset,
    orders: orders.map((order, index) => ({
      id: String(order._id),
      orderReference: order.orderNumber || String(order._id),
      status: order.status,
      customerName: order.customerName || "Unknown customer",
      customerIdentity:
        customerIdentities.get(normalizeWhatsappRecipient(order.customerPhone)) ??
        `customer-${offset + index + 1}`,
      phoneEnding: getPhoneEnding(order.customerPhone),
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
