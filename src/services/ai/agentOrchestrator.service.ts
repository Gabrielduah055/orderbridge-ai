import { executeAgentTool } from "../../agent-tools/tool.executor";
import {
  getRecentAgentConversationHistory,
  saveAgentConversationMessage
} from "../agentConversationHistory.service";
import { getOpenRouterConfig } from "./ai.config";
import { createAiProvider } from "./aiProvider.factory";
import { buildAgentSystemPrompt } from "./agentPrompt.service";
import {
  getAgentToolDefinitionsForRole,
  getPermittedAgentToolNamesForRole
} from "./agentToolDefinitions.service";
import type {
  AgentOrchestratorInput,
  AgentOrchestratorResult,
  AgentToolExecutor,
  AiMessage,
  AiProvider,
  AiUsage,
  ExecutedAgentTool
} from "./ai.types";
import type {
  SaveAgentMessageInput,
  ToolExecutionContext,
  ToolResult
} from "../../types/agent.types";
import type { IOrderDocument } from "../../models/order.model";
import { toolRegistry } from "../../agent-tools/tool.registry";

const safeFallbackMessage =
  "I'm having trouble reaching the restaurant system right now. Please try again shortly.";
const maxRoundsFallbackMessage =
  "I'm sorry, I had a little trouble with that one. Could you try again or rephrase what you'd like?";
const recoverableToolCodes = new Set([
  "MULTIPLE_MENU_ITEMS_FOUND",
  "ORDER_ITEM_QUANTITY_REQUIRED",
  "ORDER_ITEM_CLARIFICATION_NO_MATCH",
  "ORDER_DRAFT_INCOMPLETE",
  "CUSTOMER_NAME_REQUIRED",
  "ORDER_REJECTION_REASON_REQUIRED",
  "CUSTOMER_WORKFLOW_CONFLICT",
  "CAMPAIGN_INACTIVE_DAYS_REQUIRED",
  "CAMPAIGN_INACTIVE_DAYS_MISMATCH",
  "CAMPAIGN_TARGETING_MISMATCH",
  "CAMPAIGN_TYPE_MISMATCH"
]);
const campaignConfirmationPreviewToolNames = new Set([
  "create_campaign_draft",
  "update_campaign_draft",
  "approve_campaign",
  "cancel_campaign"
]);

const classifyOrchestratorError = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return "INTERNAL_ERROR";
  }

  if (error.name === "AbortError" || /\babort|timeout|timed out\b/i.test(error.message)) {
    return "PROVIDER_TIMEOUT";
  }

  if (/OpenRouter request failed with status/i.test(error.message)) {
    return "OPENROUTER_HTTP_ERROR";
  }

  if (/did not include a message|did not include text or tool calls|empty final response/i.test(error.message)) {
    return "PROVIDER_EMPTY_RESPONSE";
  }

  if (/JSON|parse|malformed/i.test(error.message)) {
    return "MALFORMED_TOOL_ARGUMENTS";
  }

  return "INTERNAL_ERROR";
};

const trustedArgumentNames = new Set([
  "restaurantId",
  "restaurant_id",
  "senderPhone",
  "sender_phone",
  "senderRole",
  "sender_role",
  "recipientPhone",
  "recipient_phone",
  "apiKey",
  "api_key",
  "wasenderSessionId",
  "wasender_session_id",
  "wasenderApiToken",
  "wasender_api_token",
  "accessToken",
  "access_token",
  "sessionKey",
  "session_key",
  "conversationKey",
  "conversation_key"
]);

const normalizeText = (value: string): string => value.trim().replace(/\s+/g, " ");

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const registeredToolNames = Object.keys(toolRegistry).sort(
  (first, second) => second.length - first.length
);

/** Deterministic final-text guard for staff WhatsApp responses. */
export const sanitizeStaffFacingFinalText = (text: string): string => {
  let sanitized = text;

  for (const toolName of registeredToolNames) {
    sanitized = sanitized.replace(
      new RegExp(
        `(?:\\b(?:my|the|this|our)\\s+)?\`?${escapeRegExp(toolName)}\`?(?:\\s+(?:tool|function|service))?`,
        "gi"
      ),
      "restaurant system"
    );
  }

  return sanitized
    .replace(/`?\b[a-f0-9]{24}\b`?/gi, "internal reference")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
};

interface GroundedCustomerListResult {
  totalMatched: number;
  returnedCount: number;
  truncated: boolean;
  customers: unknown[];
}

interface GroundedOrderListResult {
  kind?: "order_list";
  period: { label: string; timezone: string };
  totalMatched: number;
  returnedCount: number;
  truncated: boolean;
  nextOffset: number | null;
  orders: Array<{
    orderReference: string;
    customerName: string;
    customerIdentity?: string;
    phoneEnding?: string;
    placedAtFormatted: string;
  }>;
}

interface GroundedOrderClarificationResult {
  kind: "customer_clarification";
  code:
    | "CUSTOMER_CLARIFICATION_REQUIRED"
    | "CUSTOMER_CLARIFICATION_INVALID"
    | "CUSTOMER_CLARIFICATION_AMBIGUOUS"
    | "CUSTOMER_CLARIFICATION_EXPIRED";
  message: string;
  customerName?: string;
  candidates: Array<{
    number: number;
    customerName: string;
    phoneEnding: string;
  }>;
}

type GroundedOrderQueryResult =
  | GroundedOrderListResult
  | GroundedOrderClarificationResult;

interface GroundedBusinessReportResult {
  period: { type: string; label: string; timezone: string };
  orders: { total: number };
  busiestDates: Array<{
    date: string;
    day: string;
    totalOrders: number;
  }>;
  busiestWeekdays: Array<{
    day: string;
    totalOrders: number;
    occurrences: number;
    averageOrdersPerOccurrence: number;
  }>;
}

const parseGroundedOrderListResult = (
  value: unknown
): GroundedOrderQueryResult | null => {
  if (!value || typeof value !== "object") return null;
  const possibleClarification = value as GroundedOrderClarificationResult;
  if (possibleClarification.kind === "customer_clarification") {
    if (
      typeof possibleClarification.code !== "string" ||
      typeof possibleClarification.message !== "string" ||
      !Array.isArray(possibleClarification.candidates) ||
      possibleClarification.candidates.some(
        (candidate) =>
          !candidate ||
          typeof candidate.number !== "number" ||
          typeof candidate.customerName !== "string" ||
          typeof candidate.phoneEnding !== "string"
      )
    ) {
      return null;
    }
    return possibleClarification;
  }

  const result = value as GroundedOrderListResult;
  if (
    !result.period ||
    typeof result.period.label !== "string" ||
    typeof result.totalMatched !== "number" ||
    typeof result.returnedCount !== "number" ||
    typeof result.truncated !== "boolean" ||
    !Array.isArray(result.orders)
  ) {
    return null;
  }
  return result;
};

const buildGroundedOrderListAnswer = (
  ownerMessage: string,
  result: GroundedOrderQueryResult | undefined
): string | null => {
  if (!result) return null;
  if (result.kind === "customer_clarification") {
    if (result.code === "CUSTOMER_CLARIFICATION_EXPIRED") {
      return result.message;
    }
    const choices = result.candidates.map(
      (candidate) =>
        `${candidate.number}. ${candidate.customerName} — phone ending ${candidate.phoneEnding}`
    );
    return [result.message, ...choices].join("\n");
  }
  const message = ownerMessage.toLowerCase();
  const asksWho = /\b(?:who|which customers?|customer names?|who placed|who made)\b/.test(message);
  const asksWhen = /\b(?:what time|what date|when|date and time)\b/.test(message);
  const asksForPage =
    /\b(?:remaining records?|next page|show more|more results?|continue)\b/.test(
      message
    );
  if (!asksWho && !asksWhen && !asksForPage) return null;
  if (result.totalMatched === 0) {
    return `No orders matched ${result.period.label.toLowerCase()}.`;
  }
  if (result.returnedCount === 0 || result.orders.length === 0) {
    return `There are no more matching orders to show for ${result.period.label.toLowerCase()}.`;
  }

  const customerCounts = new Map<
    string,
    { name: string; phoneEnding?: string; count: number }
  >();
  for (const [index, order] of result.orders.entries()) {
    const identity =
      order.customerIdentity || `unknown-customer:${index}`;
    const current = customerCounts.get(identity);
    customerCounts.set(identity, {
      name: order.customerName,
      phoneEnding: order.phoneEnding,
      count: (current?.count ?? 0) + 1
    });
  }
  const nameOccurrences = new Map<string, number>();
  for (const customer of customerCounts.values()) {
    const nameKey = customer.name.trim().toLowerCase();
    nameOccurrences.set(nameKey, (nameOccurrences.get(nameKey) ?? 0) + 1);
  }
  const getCustomerLabel = (customer: {
    name: string;
    phoneEnding?: string;
  }): string => {
    const duplicateName =
      (nameOccurrences.get(customer.name.trim().toLowerCase()) ?? 0) > 1;
    if (!duplicateName || !customer.phoneEnding) return customer.name;
    return `${customer.name} (phone ending ${customer.phoneEnding})`;
  };
  const completeResult =
    !result.truncated &&
    result.returnedCount === result.totalMatched &&
    result.orders.length === result.totalMatched;
  const pageHeader = `Showing ${result.returnedCount} of ${result.totalMatched} matching orders.`;
  const continuation = result.nextOffset !== null
    ? "Ask to see the next page for more matching orders."
    : null;

  if (asksWho && !asksWhen) {
    const lines = Array.from(customerCounts.values()).map(
      (customer, index) =>
        `${index + 1}. ${getCustomerLabel(customer)} — ${customer.count} order${customer.count === 1 ? "" : "s"}`
    );
    const header = `${customerCounts.size} customer${customerCounts.size === 1 ? "" : "s"} placed the ${result.totalMatched} matching order${result.totalMatched === 1 ? "" : "s"}:`;
    return [completeResult ? header : pageHeader, ...lines, continuation]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }

  const onlyCustomer = completeResult && customerCounts.size === 1
    ? Array.from(customerCounts.values())[0]
    : undefined;
  const header = onlyCustomer
    ? `${getCustomerLabel(onlyCustomer)} placed ${result.totalMatched === 2 ? "both" : result.totalMatched} order${result.totalMatched === 1 ? "" : "s"}:`
    : completeResult
      ? `Matching orders for ${result.period.label.toLowerCase()}:`
      : pageHeader;
  const lines = result.orders.map(
    (order, index) =>
      `${index + 1}. ${order.orderReference} — ${order.placedAtFormatted}${onlyCustomer ? "" : ` — ${getCustomerLabel({ name: order.customerName, phoneEnding: order.phoneEnding })}`}`
  );
  return [header, ...lines, continuation]
    .filter((line): line is string => Boolean(line))
    .join("\n");
};

const parseGroundedBusinessReportResult = (
  value: unknown
): GroundedBusinessReportResult | null => {
  if (!value || typeof value !== "object") return null;
  const result = value as GroundedBusinessReportResult;
  return result.period && result.orders && Array.isArray(result.busiestDates) &&
    Array.isArray(result.busiestWeekdays)
    ? result
    : null;
};

const capitalize = (value: string): string =>
  value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;

const formatGroundedCalendarDate = (value: string): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric"
  }).format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))));
};

const buildGroundedBusiestAnswer = (
  ownerMessage: string,
  result: GroundedBusinessReportResult | undefined
): string | null => {
  if (!result) return null;
  const message = ownerMessage.toLowerCase();
  const asksWeekday = /\b(?:weekday|day of the week|usually busiest|normally busiest)\b/.test(message);
  const asksDate = /\b(?:busiest date|which date|calendar date)\b/.test(message);
  if (!asksWeekday && !asksDate) return null;
  const scope = result.period.type === "all_time"
    ? "across all recorded activity"
    : `for ${result.period.label.toLowerCase()}`;
  if (result.orders.total === 0) {
    return `There are no recorded orders ${scope}, so there is no busiest ${asksWeekday ? "weekday" : "date"}.`;
  }
  if (asksWeekday) {
    const entries = result.busiestWeekdays;
    const lead = entries.length > 1
      ? `There is a tie for busiest weekday ${scope}:`
      : `The busiest weekday ${scope} is ${capitalize(entries[0].day)}.`;
    const details = entries.map((entry, index) =>
      `${entries.length > 1 ? `${index + 1}. ` : ""}${capitalize(entry.day)} — ${entry.totalOrders} total order${entry.totalOrders === 1 ? "" : "s"} across ${entry.occurrences} occurrence${entry.occurrences === 1 ? "" : "s"}; ${entry.averageOrdersPerOccurrence.toFixed(2)} per occurrence on average.`
    );
    if (result.orders.total < 7) {
      details.push("This is a small recorded sample, so it does not yet establish a reliable recurring pattern.");
    }
    return [lead, ...details].join("\n");
  }
  const entries = result.busiestDates;
  const lead = entries.length > 1
    ? `There is a tie for busiest calendar date ${scope}:`
    : `The busiest calendar date ${scope} was:`;
  return [
    lead,
    ...entries.map((entry, index) =>
      `${index + 1}. ${formatGroundedCalendarDate(entry.date)} (${capitalize(entry.day)}) — ${entry.totalOrders} order${entry.totalOrders === 1 ? "" : "s"}`
    )
  ].join("\n");
};

interface GroundedCustomerInsightsResult {
  status: "found" | "not_found" | "ambiguous";
  found: boolean;
  matchCount?: number;
  candidates?: Array<{
    name: string;
    maskedPhone: string;
    orderCount: number;
  }>;
  customer?: {
    name: string;
    maskedPhone: string;
    completedOrderCount: number;
    lastCompletedOrderAt: string | null;
    averageCompletedOrderValue: number;
    preferredOrderType: "pickup" | "delivery" | null;
    returning: boolean;
    marketingStatus: string;
    marketingEligibility: string;
    canReceivePromotions: boolean;
    frequentlyOrderedItems: Array<{
      name: string;
      orderCount: number;
      totalQuantity: number;
    }>;
  };
}

interface GroundedCustomerSegmentResult {
  status: "ok" | "menu_item_not_found" | "ambiguous_menu_item";
  segmentType?: string;
  menuItemName?: string;
  candidates?: string[];
  segment?: {
    type: string;
    inactiveDays?: number;
    menuItemName?: string;
    startDate?: string;
    endDate?: string;
  };
  totalCustomers?: number;
  customersWithCompletedOrders?: number;
  totalCompletedOrderCount?: number;
  marketingEligibleCustomers?: number;
  excludedNoConsent?: number;
  excludedOptOut?: number;
  excludedInvalidPhone?: number;
  historicalTopItems?: Array<{
    name: string;
    customerCount: number;
    orderCount: number;
    totalQuantity: number;
  }>;
  preferredOrderTypeDistribution?: {
    pickup: number;
    delivery: number;
    unknown: number;
  };
  memberTotalMatched?: number;
  returnedMemberCount?: number;
  membersTruncated?: boolean;
  memberMarketingEligibleOnly?: boolean;
  customers?: Array<{
    name: string;
    maskedPhone: string;
    completedOrderCount: number;
    lastCompletedOrderAt: string | null;
    marketingStatus: string;
    marketingEligibility: string;
  }>;
}

const parseGroundedCustomerInsightsResult = (
  value: unknown
): GroundedCustomerInsightsResult | null => {
  if (!value || typeof value !== "object") return null;
  const result = value as GroundedCustomerInsightsResult;
  if (!["found", "not_found", "ambiguous"].includes(result.status)) {
    return null;
  }
  if (result.status === "found") {
    const customer = result.customer;
    if (
      result.found !== true ||
      !customer ||
      typeof customer.name !== "string" ||
      typeof customer.maskedPhone !== "string" ||
      typeof customer.completedOrderCount !== "number" ||
      typeof customer.averageCompletedOrderValue !== "number" ||
      typeof customer.returning !== "boolean" ||
      typeof customer.marketingStatus !== "string" ||
      typeof customer.marketingEligibility !== "string" ||
      typeof customer.canReceivePromotions !== "boolean" ||
      !Array.isArray(customer.frequentlyOrderedItems)
    ) {
      return null;
    }
  }
  if (
    result.status === "ambiguous" &&
    (typeof result.matchCount !== "number" || !Array.isArray(result.candidates))
  ) {
    return null;
  }
  return result;
};

const buildGroundedCustomerInsightsAnswer = (
  ownerMessage: string,
  result: GroundedCustomerInsightsResult | undefined
): string | null => {
  if (!result) return null;
  if (result.status === "not_found") {
    return "No customer matched that exact name or phone number.";
  }
  if (result.status === "ambiguous") {
    const candidates = (result.candidates ?? []).map(
      (candidate, index) =>
        `${index + 1}. ${candidate.name} — ${candidate.maskedPhone} — ${candidate.orderCount} completed order${candidate.orderCount === 1 ? "" : "s"}`
    );
    return `I found ${result.matchCount} customers with that name. Which one do you mean?${candidates.length > 0 ? `\n${candidates.join("\n")}` : ""}`;
  }

  const customer = result.customer as NonNullable<GroundedCustomerInsightsResult["customer"]>;
  const message = ownerMessage.toLowerCase();
  if (
    /\bhow many\b.*\borders?\b|\b(?:completed order count|order count)\b/.test(
      message
    )
  ) {
    return `${customer.name} has completed ${customer.completedOrderCount} order${customer.completedOrderCount === 1 ? "" : "s"}.`;
  }
  if (/\breturning customer\b/.test(message)) {
    return customer.returning
      ? `Yes, ${customer.name} is a returning customer.`
      : `No, ${customer.name} is not a returning customer.`;
  }
  if (/\baverage\b.*\b(?:order|value|spend)|\baverage order value\b/.test(message)) {
    return `${customer.name}'s average completed order value is GHS ${customer.averageCompletedOrderValue.toFixed(2)}.`;
  }
  if (/\b(?:usually|normally|frequently|often)\b.*\b(?:order|buy)|\bwhat\b.*\b(?:order|buy)/.test(message)) {
    const items = customer.frequentlyOrderedItems.slice(0, 5);
    return items.length === 0
      ? `${customer.name} has no completed-order item history yet.`
      : `${customer.name}'s historical completed-order preferences are ${items.map((item) => `${item.name} (${item.totalQuantity} portion${item.totalQuantity === 1 ? "" : "s"} across ${item.orderCount} order${item.orderCount === 1 ? "" : "s"})`).join(", ")}.`;
  }
  if (/\b(?:last order|last ordered|when did)\b/.test(message)) {
    return customer.lastCompletedOrderAt
      ? `${customer.name}'s last completed order was ${customer.lastCompletedOrderAt}.`
      : `${customer.name} has no completed order date.`;
  }
  if (/\b(?:delivery|pickup|order type)\b/.test(message)) {
    return customer.preferredOrderType
      ? `${customer.name} usually uses ${customer.preferredOrderType}.`
      : `${customer.name} does not have a preferred order type yet.`;
  }
  if (/\b(?:can|eligible)\b.*\b(?:receive )?(?:promotion|promotions|marketing)\b/.test(message)) {
    const labels: Record<string, string> = {
      eligible: "can currently receive promotions",
      no_consent:
        "cannot currently receive promotions because they explicitly declined them",
      opted_out: "is opted out and cannot receive promotions",
      invalid_recipient:
        "cannot currently receive promotions because there is no valid promotional WhatsApp recipient"
    };
    return `${customer.name} ${labels[customer.marketingEligibility] ?? "cannot currently receive promotions"}.`;
  }
  if (/\b(?:marketing status|consent status|marketing consent|opted)\b/.test(message)) {
    const labels: Record<string, string> = {
      opted_in: "opted in",
      opted_out: "opted out",
      awaiting_response: "awaiting a response",
      not_asked: "not yet asked"
    };
    return `${customer.name}'s marketing consent status is ${labels[customer.marketingStatus] ?? customer.marketingStatus.replace(/_/g, " ")}.`;
  }

  const itemSummary = customer.frequentlyOrderedItems.length > 0
    ? customer.frequentlyOrderedItems
        .slice(0, 3)
        .map((item) => item.name)
        .join(", ")
    : "none yet";
  return [
    `${customer.name} (${customer.maskedPhone}) has completed ${customer.completedOrderCount} order${customer.completedOrderCount === 1 ? "" : "s"}, averaging GHS ${customer.averageCompletedOrderValue.toFixed(2)}.`,
    `Last completed order: ${customer.lastCompletedOrderAt ?? "none"}; preferred order type: ${customer.preferredOrderType ?? "not established"}.`,
    `Historical frequent items: ${itemSummary}. Marketing consent: ${customer.marketingStatus.replace(/_/g, " ")}; promotional eligibility: ${customer.marketingEligibility.replace(/_/g, " ")}.`
  ].join("\n");
};

const parseGroundedCustomerSegmentResult = (
  value: unknown
): GroundedCustomerSegmentResult | null => {
  if (!value || typeof value !== "object") return null;
  const result = value as GroundedCustomerSegmentResult;
  if (
    !["ok", "menu_item_not_found", "ambiguous_menu_item"].includes(
      result.status
    )
  ) {
    return null;
  }
  if (
    result.status === "ok" &&
    (typeof result.totalCustomers !== "number" ||
      typeof result.customersWithCompletedOrders !== "number" ||
      typeof result.totalCompletedOrderCount !== "number" ||
      typeof result.marketingEligibleCustomers !== "number" ||
      typeof result.excludedNoConsent !== "number" ||
      typeof result.excludedOptOut !== "number" ||
      typeof result.excludedInvalidPhone !== "number" ||
      !result.segment ||
      !Array.isArray(result.historicalTopItems) ||
      !result.preferredOrderTypeDistribution)
  ) {
    return null;
  }
  if (
    result.status === "ok" &&
    result.customers !== undefined &&
    (typeof result.memberTotalMatched !== "number" ||
      typeof result.returnedMemberCount !== "number" ||
      typeof result.membersTruncated !== "boolean" ||
      typeof result.memberMarketingEligibleOnly !== "boolean" ||
      !Array.isArray(result.customers))
  ) {
    return null;
  }
  return result;
};

const buildGroundedCustomerSegmentAnswer = (
  ownerMessage: string,
  result: GroundedCustomerSegmentResult | undefined
): string | null => {
  if (!result) return null;
  if (result.status === "menu_item_not_found") {
    return `No restaurant menu item matched ${result.menuItemName ?? "that name"}.`;
  }
  if (result.status === "ambiguous_menu_item") {
    return `I found multiple matching menu items. Which one do you mean?${(result.candidates ?? []).map((name, index) => `\n${index + 1}. ${name}`).join("")}`;
  }

  const total = result.totalCustomers as number;
  const eligible = result.marketingEligibleCustomers as number;
  const segment = result.segment as NonNullable<GroundedCustomerSegmentResult["segment"]>;
  const segmentLabel =
    segment.type === "inactive_customers"
      ? `customers inactive for more than ${segment.inactiveDays} days`
      : segment.type === "returning_customers"
        ? "returning customers"
        : segment.type === "ordered_menu_item"
          ? `customers who completed an order containing ${segment.menuItemName}`
          : segment.type === "last_order_date_range"
            ? `customers whose last completed order was from ${segment.startDate} to ${segment.endDate}`
            : "customers";
  const message = ownerMessage.toLowerCase();

  if (Array.isArray(result.customers)) {
    const customers = result.customers.filter(
      (customer) =>
        customer &&
        typeof customer.name === "string" &&
        typeof customer.maskedPhone === "string" &&
        typeof customer.completedOrderCount === "number"
    );
    const memberTotal = result.memberTotalMatched as number;
    const returned = result.returnedMemberCount as number;
    const eligibleLabel = result.memberMarketingEligibleOnly
      ? " eligible"
      : "";
    if (memberTotal === 0) {
      return `No${eligibleLabel} ${segmentLabel} matched.`;
    }
    const header = result.membersTruncated
      ? `Showing ${returned} of ${memberTotal}${eligibleLabel} ${segmentLabel}:`
      : `${memberTotal}${eligibleLabel} ${segmentLabel} matched:`;
    return `${header}\n${customers.map((customer, index) => `${index + 1}. ${customer.name} — ${customer.maskedPhone} — ${customer.completedOrderCount} completed order${customer.completedOrderCount === 1 ? "" : "s"}`).join("\n")}`;
  }

  if (/\bopted[ -]?out\b/.test(message)) {
    return `${result.excludedOptOut} of ${total} ${segmentLabel} are opted out.`;
  }
  if (
    /\b(?:haven't|have not|without|no)\b.*\bconsent\b|\bconsent not confirmed\b/.test(
      message
    )
  ) {
    return `${result.excludedNoConsent} of ${total} ${segmentLabel} explicitly declined promotions.`;
  }
  if (
    /\b(?:invalid|valid|without|don't have|do not have)\b.*\b(?:whatsapp|recipient)\b/.test(
      message
    )
  ) {
    return `${result.excludedInvalidPhone} of ${total} ${segmentLabel} do not have a valid promotional WhatsApp recipient.`;
  }
  if (
    /\bhow many\b.*\b(?:customers?|them)\b.*\b(?:have|with)\b.*\bcompleted orders?\b/.test(
      message
    )
  ) {
    return `${result.customersWithCompletedOrders} of ${total} ${segmentLabel} have completed orders.`;
  }
  if (
    /\b(?:how many|total)\b.*\bcompleted orders?\b.*\b(?:represent|altogether|in total)\b|\btotal completed orders?\b/.test(
      message
    )
  ) {
    return `Those ${segmentLabel} represent ${result.totalCompletedOrderCount} completed order${result.totalCompletedOrderCount === 1 ? "" : "s"}.`;
  }
  if (
    /\b(?:delivery or pickup|pickup or delivery|normally use|usually use|order type)\b/.test(
      message
    )
  ) {
    const distribution = result.preferredOrderTypeDistribution as NonNullable<GroundedCustomerSegmentResult["preferredOrderTypeDistribution"]>;
    return `Preferred order types for those ${segmentLabel}: delivery ${distribution.delivery}, pickup ${distribution.pickup}, not established ${distribution.unknown}.`;
  }

  if (/\b(?:normally order|usually order|normally buy|usually buy|what do .* order|what do .* buy)\b/.test(message)) {
    const items = (result.historicalTopItems ?? []).slice(0, 5);
    return items.length === 0
      ? `Those ${segmentLabel} have no completed-order item history.`
      : `Historical completed-order preferences for those ${segmentLabel}:\n${items.map((item, index) => `${index + 1}. ${item.name} — ${item.customerCount} customer${item.customerCount === 1 ? "" : "s"}, ${item.orderCount} order${item.orderCount === 1 ? "" : "s"}, ${item.totalQuantity} portion${item.totalQuantity === 1 ? "" : "s"}`).join("\n")}`;
  }
  if (/\b(?:can receive|eligible|eligibility|promotions?|marketing)\b/.test(message)) {
    return `${eligible} of ${total} ${segmentLabel} can currently receive promotions.`;
  }
  return `${total} ${segmentLabel} matched. ${eligible} can currently receive promotions.`;
};

const parseGroundedCustomerListResult = (
  value: unknown
): GroundedCustomerListResult | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const result = value as Record<string, unknown>;
  if (
    typeof result.totalMatched !== "number" ||
    !Number.isInteger(result.totalMatched) ||
    result.totalMatched < 0 ||
    typeof result.returnedCount !== "number" ||
    !Number.isInteger(result.returnedCount) ||
    result.returnedCount < 0 ||
    typeof result.truncated !== "boolean" ||
    !Array.isArray(result.customers)
  ) {
    return null;
  }

  return {
    totalMatched: result.totalMatched,
    returnedCount: result.returnedCount,
    truncated: result.truncated,
    customers: result.customers
  };
};

export const isDirectCustomerListRequest = (message: string): boolean => {
  const normalized = normalizeText(message).toLowerCase();
  if (
    /\b(?:how many|number of|total|count|audience size|why)\b/.test(normalized)
  ) {
    return false;
  }

  const asksForIdentities =
    /\b(?:who|list|show|name|which)\b/.test(normalized) ||
    /\b(?:give me|tell me|can i see)\b/.test(normalized);
  const mentionsCustomerAudience =
    /\b(?:customers?|people|marketing audience)\b/.test(normalized) ||
    /\b(?:opted[ -]?in|returning customers?|accepted marketing|agreed to (?:marketing|promotions?))\b/.test(
      normalized
    );

  return asksForIdentities && mentionsCustomerAudience;
};

const buildGroundedCustomerListAnswer = (
  ownerMessage: string,
  result: GroundedCustomerListResult | undefined,
  args: Record<string, unknown> | undefined
): string | null => {
  if (!result) {
    return null;
  }

  const optedIn = args?.marketingStatus === "opted_in";
  if (!isDirectCustomerListRequest(ownerMessage)) {
    return null;
  }

  if (result.totalMatched === 0) {
    return optedIn
      ? "There are currently no opted-in customers."
      : "No customers matched those filters.";
  }

  const safeCustomers = result.customers
    .filter(
      (customer): customer is Record<string, unknown> =>
        Boolean(customer) && typeof customer === "object"
    )
    .filter(
      (customer) =>
        typeof customer.name === "string" && Boolean(customer.name.trim())
    );

  if (safeCustomers.length === 0) {
    return `${result.totalMatched} customer${result.totalMatched === 1 ? "" : "s"} matched.`;
  }

  const includeDetails =
    /\b(?:details?|phone|number|how many orders|order counts?|average|last order)\b/i.test(
      ownerMessage
    );
  const lines = safeCustomers.map((customer, index) => {
    const name = String(customer.name);
    if (!includeDetails) {
      return `${index + 1}. ${name}`;
    }

    const details = [
      typeof customer.orderCount === "number"
        ? `${customer.orderCount} completed order${customer.orderCount === 1 ? "" : "s"}`
        : undefined,
      typeof customer.maskedPhone === "string"
        ? customer.maskedPhone
        : undefined
    ].filter((detail): detail is string => Boolean(detail));

    return `${index + 1}. ${name}${details.length > 0 ? ` — ${details.join(" — ")}` : ""}`;
  });

  const noun = `${result.totalMatched} customer${result.totalMatched === 1 ? "" : "s"}`;
  const summary = optedIn
    ? `${noun} ${result.totalMatched === 1 ? "has" : "have"} opted in`
    : `${noun} matched`;
  const header = result.truncated
    ? `${summary}. Showing the first ${result.returnedCount}:`
    : `${summary}:`;

  return [header, ...lines].join("\n");
};

const stripTrustedModelArguments = (
  args: Record<string, unknown>
): Record<string, unknown> => {
  return Object.fromEntries(
    Object.entries(args).filter(([key]) => !trustedArgumentNames.has(key))
  );
};

const orderMutationToolNames = new Set([
  "cancel_order",
  "confirm_order",
  "reject_order",
  "resolve_customer_cancellation_request",
  "update_order_status"
]);

const customerOrderWorkflowMutationTools = new Set([
  "start_order",
  "add_order_item_by_name",
  "remove_order_item_by_name",
  "update_order_item_quantity",
  "update_order_draft",
  "confirm_order_draft",
  "cancel_order_draft",
  "cancel_order",
  "amend_submitted_order"
]);

type CustomerWorkflowMutation = "active_order" | "order_feedback";

const getCustomerWorkflowMutation = (
  toolName: string
): CustomerWorkflowMutation | null => {
  if (customerOrderWorkflowMutationTools.has(toolName)) {
    return "active_order";
  }

  return toolName === "respond_to_order_check_in"
    ? "order_feedback"
    : null;
};

const getRequestedOrderReferences = (
  args: Record<string, unknown>
): string[] => {
  return [args.orderId, args.orderReference]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
};

const referencesMatchAllowedValues = (
  requestedReferences: string[],
  allowedReferences: Array<string | undefined>
): boolean => {
  const allowed = new Set(
    allowedReferences
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );

  return (
    requestedReferences.length > 0 &&
    allowed.size > 0 &&
    requestedReferences.every((reference) => allowed.has(reference))
  );
};

const getTrustedOrderReferenceGuardResult = (
  input: AgentOrchestratorInput,
  toolName: string,
  args: Record<string, unknown>
): ToolResult | null => {
  if (
    (input.sender.role !== "owner" && input.sender.role !== "manager") ||
    !orderMutationToolNames.has(toolName)
  ) {
    return null;
  }

  const requestedReferences = getRequestedOrderReferences(args);
  const selection = input.staffState?.recentReferences.orderSelection;

  if (selection?.decision === "reject" && selection.awaitingReason) {
    if (toolName !== "reject_order") {
      return {
        success: false,
        code: "ORDER_WORKFLOW_CONFLICT",
        message:
          "Only rejecting one of the selected orders is allowed while the rejection reason is pending."
      };
    }

    const allowedOrderReferences = selection.candidates.flatMap((candidate) => [
      candidate.id,
      ...(candidate.orderNumber ? [candidate.orderNumber] : [])
    ]);

    if (!referencesMatchAllowedValues(requestedReferences, allowedOrderReferences)) {
      return {
        success: false,
        code: "ORDER_REFERENCE_MISMATCH",
        message: "The requested order does not match the active order selection."
      };
    }
  }

  const explicitCurrentReference = input.message.match(
    /\b(ORD-[A-Za-z0-9-]+|[a-f0-9]{24})\b/i
  )?.[1];
  const quotedOrder = input.staffState?.recentReferences.quotedOrder;

  if (
    input.quotedMessageId &&
    quotedOrder?.quotedVersionStale &&
    ["confirm_order", "reject_order", "update_order_status"].includes(toolName)
  ) {
    return {
      success: false,
      code: "ORDER_NOTIFICATION_VERSION_STALE",
      message: `That order has been updated since this message. Please review the latest ${quotedOrder.orderNumber ?? "order"} update before accepting or rejecting it.`
    };
  }

  if (
    input.quotedMessageId &&
    quotedOrder?.quotedAction === "cancellation_request" &&
    toolName !== "resolve_customer_cancellation_request"
  ) {
    return {
      success: false,
      code: "QUOTED_ORDER_ACTION_MISMATCH",
      message: "That quoted message is a customer cancellation request. Please approve or decline that request."
    };
  }

  if (input.quotedMessageId && !explicitCurrentReference && quotedOrder) {
    if (
      !referencesMatchAllowedValues(requestedReferences, [
        quotedOrder.id,
        quotedOrder.orderNumber
      ])
    ) {
      return {
        success: false,
        code: "ORDER_REFERENCE_MISMATCH",
        message: "The requested order does not match the quoted order."
      };
    }
  }

  return null;
};

const toConversationMessage = (message: {
  role: string;
  content: string;
}): AiMessage | null => {
  if (message.role !== "user" && message.role !== "assistant") {
    return null;
  }

  return {
    role: message.role,
    content: message.content
  };
};

const buildToolResultForModel = (toolName: string, result: ToolResult) => ({
  success: result.success,
  tool: toolName,
  message: result.message,
  code: result.code,
  data: removeImageUrlsForModel(result.data),
  requiresConfirmation: result.requiresConfirmation,
  pendingActionId: result.pendingActionId
});

const getExecutedOrderMetadata = (data: unknown) => {
  if (!data || typeof data !== "object") {
    return {};
  }

  const order = (data as Record<string, unknown>).order;
  if (!order || typeof order !== "object") {
    return {};
  }

  const source = order as Record<string, unknown>;
  const rawId = source.id ?? source._id;

  return {
    resultOrderId:
      rawId === undefined || rawId === null ? undefined : String(rawId),
    resultOrderNumber:
      typeof source.orderNumber === "string" ? source.orderNumber : undefined,
    resultOrderStatus:
      typeof source.status === "string" ? source.status : undefined
  };
};

const removeImageUrlsForModel = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(removeImageUrlsForModel);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const source = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  let hasImage = false;
  let containsImageField = false;

  for (const [key, entryValue] of Object.entries(source)) {
    if (key === "imageUrl") {
      containsImageField = true;
      hasImage = typeof entryValue === "string" && Boolean(entryValue.trim());
      continue;
    }

    if (key === "mediaItemId") {
      continue;
    }

    sanitized[key] = removeImageUrlsForModel(entryValue);
  }

  if (containsImageField) {
    sanitized.hasImage = hasImage;
  }

  return sanitized;
};

const getImportantData = (
  currentData: AgentOrchestratorResult["data"],
  result: ToolResult,
  toolName: string,
  toolArguments: Record<string, unknown>
): AgentOrchestratorResult["data"] => {
  const nextData = { ...(currentData ?? {}) };

  if (Array.isArray(result.data) && result.data.length === 1) {
    const onlyItem = result.data[0];

    if (onlyItem && typeof onlyItem === "object") {
      const item = onlyItem as Record<string, unknown>;

      if (
        toolName === "search_menu_items" &&
        toolArguments.includeImage === true &&
        typeof item.imageUrl === "string" &&
        item.imageUrl.trim() &&
        typeof item.name === "string" &&
        item.name.trim()
      ) {
        nextData.menuItemImage = {
          menuItemId:
            item.mediaItemId === undefined || item.mediaItemId === null
              ? item.id === undefined || item.id === null
                ? undefined
                : String(item.id)
              : String(item.mediaItemId),
          imageUrl: item.imageUrl,
          caption: item.name,
          source: "search_menu_items_tool"
        };
      }
    }
  } else if (result.data && typeof result.data === "object") {
    const data = result.data as Record<string, unknown>;

    if (data.order) {
      nextData.order = data.order as IOrderDocument;
    }

    for (const key of [
      "orderEvent",
      "notifyOwner",
      "notifyCustomer",
      "receiptRequired",
      "orderSubmitted",
      "idempotent"
    ]) {
      if (key in data) {
        nextData[key] = data[key];
      }
    }
  }

  if (result.pendingActionId) {
    nextData.pendingActionId = result.pendingActionId;
  }

  return Object.keys(nextData).length > 0 ? nextData : undefined;
};

const isClearCustomerMenuMediaRequest = (input: AgentOrchestratorInput): boolean => {
  if (input.sender.role !== "customer") {
    return false;
  }

  const message = normalizeText(input.message).toLowerCase();

  if (/\b(order|cart|delivery status|order status)\b/.test(message)) {
    return false;
  }

  return (
    /\bwhat does\b.+\blook like\b/.test(message) ||
    /^(?:please\s+)?(?:lemme see|let me see|show me|show it|show me that|can i see(?: it)?)\b/.test(
      message
    ) ||
    /^(?:please\s+)?send\s+(?:it|(?:the\s+)?(?:pic|photo|image|picture))\b/.test(
      message
    ) ||
    /\bany\s+(?:pic|photo|image|picture)\s+of\s+.+/.test(message)
  );
};

const isMenuMediaClarification = (message: string): boolean =>
  /\b(?:which|what)\s+(?:menu\s+)?(?:item|one|dish|meal|image|picture|photo)\b/i.test(
    message
  ) || /\bwhich one\b/i.test(message);

const sanitizeMenuItemImageResponse = (
  message: string,
  data: AgentOrchestratorResult["data"]
): string => {
  const candidate = data?.menuItemImage;

  if (!candidate || typeof candidate !== "object") {
    return message;
  }

  const caption = (candidate as Record<string, unknown>).caption;

  if (/https?:\/\/\S+/i.test(message)) {
    return typeof caption === "string" && caption.trim()
      ? `Here is ${caption}.`
      : "Here is the saved menu-item image.";
  }

  const withoutUrls = message
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/ {2,}/g, " ")
    .trim();

  if (withoutUrls) {
    return withoutUrls;
  }

  return typeof caption === "string" && caption.trim()
    ? `Here is ${caption}.`
    : "Here is the saved menu-item image.";
};

const mergeUsage = (current: AiUsage | undefined, next: AiUsage | undefined): AiUsage | undefined => {
  if (!next) {
    return current;
  }

  return {
    inputTokens: (current?.inputTokens ?? 0) + (next.inputTokens ?? 0),
    outputTokens: (current?.outputTokens ?? 0) + (next.outputTokens ?? 0),
    totalTokens: (current?.totalTokens ?? 0) + (next.totalTokens ?? 0)
  };
};

const looksLikeSuccessClaim = (message: string): boolean => {
  return /\b(done|completed|confirmed|approved|placed|created|scheduled|rescheduled|updated|cancell?ed|sent|delivered|successfully|has been|is now|set up)\b/i.test(
    message
  );
};

interface RequiredOperationalTool {
  toolName: string;
  requireCompletedMutation?: boolean;
  safeMessage: string;
}

const isImplicitAllCustomerGreeting = (message: string): boolean =>
  /^(?:please\s+)?(?:send|wish|greet)\s+(?:a\s+)?(?:happy\s+)?(?:new year|new month|holidays?|seasonal)(?:\s+(?:message|greetings?|wishes?))?[.!]?$/i.test(
    normalizeText(message)
  );

const isNaturalCampaignCreationRequest = (message: string): boolean => {
  const normalized = normalizeText(message).toLowerCase();
  const asksToCommunicate =
    /\b(?:send|message|tell|notify|announce|invite|wish|greet|reach out)\b/.test(
      normalized
    );
  const targetsCustomers =
    /\b(?:all\s+(?:the\s+)?customers?|customers?|everyone|patrons?|clients?)\b/.test(
      normalized
    ) ||
    /\b(?:send|message|tell|notify|invite|wish|greet)\b.+\bto\b.+/.test(
      normalized
    ) ||
    isImplicitAllCustomerGreeting(normalized);
  const marketingContent =
    /\b(?:campaign|promotion|promo|offer|announcement|happy new month|happy new year|holiday|festive|we(?:'re| are) (?:open|active|back)|reopen(?:ed|ing)?|place (?:an |your )?order|bring (?:an |your )?orders?)\b/.test(
      normalized
    );
  const readOnly =
    /\b(?:how many|which|who|what|report|statistics?|insights?|eligible|can receive|audience size|show|list)\b/.test(
      normalized
    ) && !asksToCommunicate;

  return !readOnly && asksToCommunicate && targetsCustomers && marketingContent;
};

const mentionsInactiveCustomerAudience = (message: string): boolean =>
  /\binactive\s+(?:customers?|patrons?|clients?)\b|\b(?:customers?|patrons?|clients?)\s+inactive\b/i.test(
    normalizeText(message)
  );

const getRecentInactiveCampaignRequest = (
  history: Array<{ role: string; content: string }>,
  currentMessage: string
): string | null => {
  const latest = history[history.length - 1];
  const priorHistory =
    latest?.role === "user" &&
    normalizeText(latest.content) === normalizeText(currentMessage)
      ? history.slice(0, -1)
      : history;
  let assistantIndex = -1;

  for (let index = priorHistory.length - 1; index >= 0; index -= 1) {
    if (priorHistory[index]?.role === "assistant") {
      assistantIndex = index;
      break;
    }
  }

  if (assistantIndex < 0) {
    return null;
  }

  const assistantMessage = normalizeText(
    priorHistory[assistantIndex]?.content ?? ""
  ).toLowerCase();
  const requestedInactiveDays =
    /\b(?:inactive|inactivity)\b.*\b(?:days?|period|threshold|how long)\b/.test(
      assistantMessage
    ) ||
    /\b(?:how many days?|how long)\b.*\b(?:inactive|inactivity)\b/.test(
      assistantMessage
    );

  if (!requestedInactiveDays) {
    return null;
  }

  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const candidate = priorHistory[index];
    if (candidate?.role !== "user") {
      continue;
    }

    const candidateMessage = normalizeText(candidate.content).toLowerCase();
    return isNaturalCampaignCreationRequest(candidateMessage) &&
      mentionsInactiveCustomerAudience(candidateMessage)
      ? candidateMessage
      : null;
  }

  return null;
};

const getExplicitInactiveDays = (
  message: string,
  isClarificationReply: boolean
): number | null => {
  const normalized = normalizeText(message).toLowerCase();
  const explicitDays = normalized.match(/\b(\d{1,4})\s*days?\b/);
  const clarificationDays = isClarificationReply
    ? normalized.match(/^(\d{1,4})$/)
    : null;
  const rawDays = explicitDays?.[1] ?? clarificationDays?.[1];

  if (!rawDays) {
    return null;
  }

  const days = Number(rawDays);
  return Number.isInteger(days) && days >= 1 && days <= 3650 ? days : null;
};

const getCampaignTargeting = (
  args: Record<string, unknown>
): Record<string, unknown> | null => {
  const targeting = args.targeting;
  return targeting && typeof targeting === "object" && !Array.isArray(targeting)
    ? (targeting as Record<string, unknown>)
    : null;
};

const getExpectedCampaignType = (message: string): string | null => {
  const normalized = normalizeText(message).toLowerCase();

  if (mentionsInactiveCustomerAudience(normalized)) {
    return "inactivity_reengagement";
  }

  if (/\b(?:promo(?:tion)?|discount|offer|sale)\b|\d+\s*%/.test(normalized)) {
    return "promotion";
  }

  if (
    /\b(?:happy new month|happy new year|happy holidays?|new (?:month|year) greetings?|holiday greetings?|seasonal wishes?|festive greetings?)\b/.test(
      normalized
    ) ||
    /\b(?:wish|greet)\b.*\b(?:customers?|everyone|patrons?|clients?)\b/.test(
      normalized
    )
  ) {
    return "holiday";
  }

  if (
    /\b(?:announcement|business update|reopen(?:ed|ing)?|we(?:'re| are) (?:open|active|back))\b/.test(
      normalized
    )
  ) {
    return "announcement";
  }

  return null;
};

const getCustomerMarketingMutationIntentGuard = (
  input: AgentOrchestratorInput,
  toolName: string,
  args: Record<string, unknown>,
  recentInactiveCampaignRequest: string | null
): ToolResult | null => {
  const message = normalizeText(input.message).toLowerCase();
  const hasCampaignReference = Boolean(
    input.staffState?.recentReferences.campaign
  );
  const mentionsCampaign =
    /\b(?:campaign|promotion|promo|offer|announcement)s?\b/.test(message);

  if (toolName === "create_campaign_draft") {
    const isInactiveClarificationReply = Boolean(recentInactiveCampaignRequest);
    const explicitCreation =
      (mentionsCampaign &&
        /\b(?:create|draft|start|make|prepare|set up|launch|send|write)\b/.test(
          message
        )) ||
      isNaturalCampaignCreationRequest(message) ||
      (isInactiveClarificationReply &&
        getExplicitInactiveDays(message, true) !== null);

    if (!explicitCreation) {
      return {
        success: false,
        code: "CAMPAIGN_INTENT_REQUIRED",
        message:
          "That was a read-only customer intelligence question. No campaign draft was created."
      };
    }

    const campaignRequest = recentInactiveCampaignRequest ?? message;
    const targeting = getCampaignTargeting(args);
    const targetsInactive = mentionsInactiveCustomerAudience(campaignRequest);
    const targetsEveryone =
      /\b(?:all\s+(?:the\s+)?(?:eligible\s+)?customers?|everyone|our\s+(?:customers?|patrons?|clients?))\b/.test(
        campaignRequest
      ) || isImplicitAllCustomerGreeting(campaignRequest);

    if (targetsInactive) {
      const explicitInactiveDays = getExplicitInactiveDays(
        message,
        isInactiveClarificationReply
      );

      if (explicitInactiveDays === null) {
        return {
          success: false,
          code: "CAMPAIGN_INACTIVE_DAYS_REQUIRED",
          message:
            "How many days should a customer have been inactive before they are included?"
        };
      }

      if (targeting?.type !== "inactive_customers") {
        return {
          success: false,
          code: "CAMPAIGN_TARGETING_MISMATCH",
          message:
            "Use the inactive-customer targeting rule for this campaign and keep the owner's requested inactivity period."
        };
      }

      if (targeting.inactiveDays !== explicitInactiveDays) {
        return {
          success: false,
          code: "CAMPAIGN_INACTIVE_DAYS_MISMATCH",
          message: `Use the owner's stated inactivity period of ${explicitInactiveDays} days.`
        };
      }
    } else if (
      targetsEveryone &&
      targeting?.type !== "all_eligible_customers"
    ) {
      return {
        success: false,
        code: "CAMPAIGN_TARGETING_MISMATCH",
        message:
          "Use all eligible customers because the owner asked for all customers or everyone."
      };
    }

    const expectedCampaignType = getExpectedCampaignType(campaignRequest);
    if (
      expectedCampaignType &&
      args.campaignType !== expectedCampaignType
    ) {
      return {
        success: false,
        code: "CAMPAIGN_TYPE_MISMATCH",
        message: `Use campaign type ${expectedCampaignType} for this request.`
      };
    }

    return null;
  }

  if (toolName === "update_campaign_draft") {
    const explicitUpdate =
      (mentionsCampaign || hasCampaignReference) &&
      /\b(?:change|edit|update|rewrite|shorten|lengthen|reschedule|move|make)\b/.test(
        message
      );
    return explicitUpdate
      ? null
      : {
          success: false,
          code: "CAMPAIGN_INTENT_REQUIRED",
          message: "No campaign was changed because the owner did not request an edit."
        };
  }

  if (toolName === "approve_campaign") {
    const explicitApproval =
      (mentionsCampaign || hasCampaignReference) &&
      /\b(?:approve|confirm|yes|okay|ok|go ahead|send it)\b/.test(message);
    return explicitApproval
      ? null
      : {
          success: false,
          code: "CAMPAIGN_INTENT_REQUIRED",
          message:
            "No campaign was approved because the owner did not explicitly approve it."
        };
  }

  if (toolName === "cancel_campaign") {
    const explicitCancellation =
      (mentionsCampaign || hasCampaignReference) &&
      /\b(?:cancel|discard|delete|stop)\b/.test(message);
    return explicitCancellation
      ? null
      : {
          success: false,
          code: "CAMPAIGN_INTENT_REQUIRED",
          message:
            "No campaign was cancelled because the owner did not request cancellation."
        };
  }

  if (toolName === "invite_customers_to_marketing") {
    const explicitOutreach =
      /\b(?:invite|ask|contact|message|reach out|send)\b/.test(message) &&
      /\b(?:customers?|marketing|promotions?|consent|opt in)\b/.test(message);
    return explicitOutreach
      ? null
      : {
          success: false,
          code: "MARKETING_OUTREACH_INTENT_REQUIRED",
          message:
            "That was a read-only customer intelligence question. No marketing invitation was created or sent."
        };
  }

  return null;
};

const getRequiredCampaignOrReminderTool = (
  input: AgentOrchestratorInput
): RequiredOperationalTool | null => {
  const message = input.message.toLowerCase();
  const mentionsCampaign = /\bcampaigns?\b/.test(message);
  const naturalCampaignRequest = isNaturalCampaignCreationRequest(message);
  const trustedCampaignReference =
    input.staffState?.recentReferences.campaign;
  const hasCompetingCampaignContext = Boolean(
    input.staffState?.imageWorkflow ||
      input.staffState?.recentReferences.quotedOrder ||
      input.staffState?.recentReferences.orderSelection ||
      /\bORD-[A-Za-z0-9-]+\b/i.test(input.message) ||
      /\b[a-f0-9]{24}\b/i.test(input.message) ||
      input.staffState?.pendingActions.some(
        (action) =>
          action.requiresConfirmation &&
          action.actionId !== trustedCampaignReference?.pendingActionId
      )
  );
  const hasUnambiguousCampaignFollowUp = Boolean(
    trustedCampaignReference && !hasCompetingCampaignContext
  );
  const mentionsReminder = /\breminders?\b/.test(message);

  if (
    (mentionsCampaign || hasUnambiguousCampaignFollowUp) &&
    /\b(?:add|attach|upload|use|set)\b/.test(message) &&
    /\b(?:image|photo|picture)\b/.test(message)
  ) {
    return {
      toolName: "start_campaign_image_upload",
      safeMessage:
        "I haven't started a campaign image upload. Please identify the pending campaign whose preview should receive the image."
    };
  }

  if (
    (mentionsCampaign || hasUnambiguousCampaignFollowUp) &&
    /\b(cancel|discard|delete|stop)\b/.test(message) &&
    (mentionsCampaign || /\b(it|that|this)\b/.test(message))
  ) {
    return {
      toolName: "cancel_campaign",
      requireCompletedMutation: true,
      safeMessage:
        "I haven't cancelled that campaign. Please identify which campaign you mean so I can use the campaign controls safely."
    };
  }

  if (
    (mentionsCampaign || hasUnambiguousCampaignFollowUp) &&
    /\b(approve|confirm|send it|go ahead)\b/.test(message)
  ) {
    return {
      toolName: "approve_campaign",
      requireCompletedMutation: true,
      safeMessage:
        "I haven't approved that campaign. Please confirm the exact backend preview first."
    };
  }

  if (
    (mentionsCampaign || hasUnambiguousCampaignFollowUp) &&
    (/\b(change|edit|update|shorten|rewrite|reschedule|move)\b/.test(
      message
    ) || /\bmake\b.*\b(shorter|longer|less|more)\b/.test(message))
  ) {
    return {
      toolName: "update_campaign_draft",
      safeMessage:
        "I couldn't confirm that the campaign was updated. The previous preview remains authoritative."
    };
  }

  if (
    naturalCampaignRequest ||
    (mentionsCampaign &&
      /\b(create|start|draft|make|set up|launch|send|write)\b/.test(message))
  ) {
    return {
      toolName: "create_campaign_draft",
      safeMessage:
        "I couldn't confirm that a campaign draft was created. No campaign has been sent."
    };
  }

  if (
    mentionsReminder &&
    /\b(cancel|delete|remove)\b/.test(message)
  ) {
    return {
      toolName: "cancel_staff_reminder",
      safeMessage:
        "I couldn't confirm that the reminder was cancelled. It remains unchanged."
    };
  }

  if (
    mentionsReminder &&
    /\b(reschedule|move|change)\b/.test(message)
  ) {
    return {
      toolName: "reschedule_staff_reminder",
      safeMessage:
        "I couldn't confirm that the reminder was rescheduled. It remains unchanged."
    };
  }

  if (
    /\bremind me\b/.test(message) ||
    (mentionsReminder && /\b(create|set|schedule|add)\b/.test(message))
  ) {
    return {
      toolName: "create_staff_reminder",
      safeMessage:
        "I couldn't confirm that the reminder was scheduled. Please try again."
    };
  }

  return null;
};

const getCampaignOrReminderFalseSuccessMessage = (
  input: AgentOrchestratorInput,
  finalMessage: string,
  executedTools: ExecutedAgentTool[]
): string | null => {
  if (
    (input.sender.role !== "owner" && input.sender.role !== "manager") ||
    !looksLikeSuccessClaim(finalMessage)
  ) {
    return null;
  }

  const required = getRequiredCampaignOrReminderTool(input);

  if (!required) {
    return null;
  }

  const matchingSuccess = executedTools.some(
    (tool) =>
      tool.name === required.toolName &&
      tool.success &&
      (!required.requireCompletedMutation || !tool.requiresConfirmation)
  );

  if (!matchingSuccess) {
    return required.safeMessage;
  }

  if (
    required.toolName.startsWith("create_campaign") ||
    required.toolName === "approve_campaign"
  ) {
    if (/\b(sent|delivered)\b/i.test(finalMessage)) {
      return "The campaign has not been reported as sent. Creation and approval only prepare it for the existing scheduled delivery queue.";
    }
  }

  return null;
};

const getFailedToolSuccessClaimMessage = (
  finalMessage: string,
  executedTools: ExecutedAgentTool[]
): string | null => {
  const failedTool = executedTools.find((tool) => !tool.success);

  if (!failedTool || !looksLikeSuccessClaim(finalMessage)) {
    return null;
  }

  return failedTool.message || "I couldn't complete that request.";
};

const getRecoverableToolFallbackMessage = (
  executedTools: ExecutedAgentTool[]
): string | null => {
  const latestRecoverable = [...executedTools]
    .reverse()
    .find((tool) => tool.code && recoverableToolCodes.has(tool.code));

  return latestRecoverable?.message ?? null;
};

export interface AgentOrchestratorDependencies {
  provider?: AiProvider;
  getHistory?: typeof getRecentAgentConversationHistory;
  saveMessage?: (input: SaveAgentMessageInput) => Promise<void>;
  executeTool?: AgentToolExecutor;
  buildSystemPrompt?: typeof buildAgentSystemPrompt;
}

export const runAgentOrchestrator = async (
  input: AgentOrchestratorInput,
  dependencies: AgentOrchestratorDependencies = {}
): Promise<AgentOrchestratorResult> => {
  const provider = dependencies.provider ?? createAiProvider();
  const getHistory = dependencies.getHistory ?? getRecentAgentConversationHistory;
  const saveMessage = dependencies.saveMessage ?? saveAgentConversationMessage;
  const buildSystemPrompt = dependencies.buildSystemPrompt ?? buildAgentSystemPrompt;
  const restaurantId = String(input.restaurant._id);
  const senderIdentityKey =
    input.sender.customerKey ?? input.sender.normalizedPhone;
  const conversationKey = `${restaurantId}:${senderIdentityKey}`;
  const tools = getAgentToolDefinitionsForRole(input.sender.role);
  const permittedToolNames = getPermittedAgentToolNamesForRole(input.sender.role);
  const systemPrompt = await buildSystemPrompt(
    input.restaurant,
    input.sender,
    Array.from(permittedToolNames),
    {},
    input.staffState,
    input.trustedCustomerReplyContext
  );
  const history = await getHistory(restaurantId, senderIdentityKey, 14);
  const messages: AiMessage[] = [
    {
      role: "system",
      content: systemPrompt
    },
    ...history
      .map(toConversationMessage)
      .filter((message): message is AiMessage => Boolean(message))
  ];
  const normalizedInputMessage = normalizeText(input.message);
  const latestHistoryMessage = history[history.length - 1];
  const recentInactiveCampaignRequest = getRecentInactiveCampaignRequest(
    history,
    normalizedInputMessage
  );

  if (
    latestHistoryMessage?.role !== "user" ||
    normalizeText(latestHistoryMessage.content) !== normalizedInputMessage
  ) {
    messages.push({
      role: "user",
      content: normalizedInputMessage
    });
  }

  const executedTools: ExecutedAgentTool[] = [];
  let importantData: AgentOrchestratorResult["data"];
  let responseId: string | undefined;
  let usage: AiUsage | undefined;
  let customerMediaGroundingRetryUsed = false;
  let customerMenuMediaLookupPerformed = false;
  let completedCustomerWorkflowMutation: CustomerWorkflowMutation | null = null;
  let latestCustomerList: GroundedCustomerListResult | undefined;
  let latestCustomerListArgs: Record<string, unknown> | undefined;
  let latestCustomerInsights: GroundedCustomerInsightsResult | undefined;
  let latestCustomerSegment: GroundedCustomerSegmentResult | undefined;
  let latestOrderList: GroundedOrderQueryResult | undefined;
  let latestBusinessReport: GroundedBusinessReportResult | undefined;
  const startedAt = Date.now();
  const maxToolRounds = getOpenRouterConfig().maxToolRounds;
  const executeTool = dependencies.executeTool ?? executeAgentTool;
  const toolExecutionContext: ToolExecutionContext = {
    restaurantId,
    restaurant: input.restaurant,
    sender: input.sender,
    requestId: input.requestId,
    originalMessage: normalizedInputMessage,
    quotedMessageId: input.quotedMessageId,
    trustedStaffOrderSelection:
      input.staffState?.recentReferences.orderSelection
  };

  try {
    for (let round = 0; round < maxToolRounds; round += 1) {
      const response = await provider.complete({
        messages,
        tools,
        toolChoice: tools.length > 0 ? "auto" : "none"
      });
      responseId = response.id ?? responseId;
      usage = mergeUsage(usage, response.usage);

      if (response.toolCalls.length === 0) {
        const rawFinalMessage = response.text?.trim();

        if (!rawFinalMessage) {
          throw new Error("Agent provider returned an empty final response.");
        }

        if (
          isClearCustomerMenuMediaRequest(input) &&
          !customerMenuMediaLookupPerformed &&
          !isMenuMediaClarification(rawFinalMessage)
        ) {
          if (!customerMediaGroundingRetryUsed) {
            customerMediaGroundingRetryUsed = true;
            messages.push({
              role: "system",
              content:
                "Safety correction: do not claim menu images are inaccessible or unavailable without a grounded search_menu_items lookup. If one item is clearly referenced, call search_menu_items with includeImage=true. If the reference is ambiguous, ask which item the customer means."
            });
            continue;
          }

          console.info("[customerAgent] clarification returned", {
            restaurantId,
            reason: "ungrounded_menu_image_claim"
          });

          return {
            success: true,
            message: "Sure — which menu item would you like to see?",
            data: importantData,
            provider: provider.name,
            model: provider.model,
            responseId,
            executedTools,
            usage
          };
        }

        const imageSafeFinalMessage = sanitizeMenuItemImageResponse(
          rawFinalMessage,
          importantData
        );
        let finalMessage =
          input.sender.role === "owner" || input.sender.role === "manager"
            ? sanitizeStaffFacingFinalText(imageSafeFinalMessage)
            : imageSafeFinalMessage;
        if (input.sender.role === "owner" || input.sender.role === "manager") {
          const groundedCustomerListAnswer =
            buildGroundedCustomerListAnswer(
              normalizedInputMessage,
              latestCustomerList,
              latestCustomerListArgs
            );
          const groundedCustomerInsightsAnswer =
            buildGroundedCustomerInsightsAnswer(
              normalizedInputMessage,
              latestCustomerInsights
            );
          const groundedCustomerSegmentAnswer =
            buildGroundedCustomerSegmentAnswer(
              normalizedInputMessage,
              latestCustomerSegment
            );
          const groundedOrderListAnswer = buildGroundedOrderListAnswer(
            normalizedInputMessage,
            latestOrderList
          );
          const groundedBusiestAnswer = buildGroundedBusiestAnswer(
            normalizedInputMessage,
            latestBusinessReport
          );
          const groundedAnswer =
            groundedOrderListAnswer ??
            groundedBusiestAnswer ??
            groundedCustomerInsightsAnswer ??
            groundedCustomerSegmentAnswer ??
            groundedCustomerListAnswer;
          finalMessage = groundedAnswer
            ? sanitizeStaffFacingFinalText(groundedAnswer)
            : finalMessage;
        }

        const failedToolMessage = getFailedToolSuccessClaimMessage(finalMessage, executedTools);

        if (failedToolMessage) {
          return {
            success: false,
            message: failedToolMessage,
            data: importantData,
            provider: provider.name,
            model: provider.model,
            responseId,
            executedTools,
            usage
          };
        }

        const falseSuccessMessage = getCampaignOrReminderFalseSuccessMessage(
          input,
          finalMessage,
          executedTools
        );

        if (falseSuccessMessage) {
          return {
            success: false,
            message: falseSuccessMessage,
            data: importantData,
            provider: provider.name,
            model: provider.model,
            responseId,
            executedTools,
            usage
          };
        }

        console.info("Restaurant agent completed", {
          provider: provider.name,
          model: provider.model,
          restaurantId,
          senderRole: input.sender.role,
          conversationKey,
          toolRoundCount: round,
          requestedToolNames: executedTools.map((tool) => tool.name),
          latencyMs: Date.now() - startedAt,
          totalTokens: usage?.totalTokens
        });

        return {
          success: true,
          message: finalMessage,
          data: importantData,
          provider: provider.name,
          model: provider.model,
          responseId,
          executedTools,
          usage
        };
      }

      messages.push({
        role: "assistant",
        content: response.text ?? null,
        toolCalls: response.toolCalls
      });

      for (const toolCall of response.toolCalls) {
        const toolName = toolCall.name;
        const safeArguments = stripTrustedModelArguments(toolCall.arguments);
        const requestedCustomerWorkflow =
          input.sender.role === "customer"
            ? getCustomerWorkflowMutation(toolName)
            : null;
        const workflowConflictResult: ToolResult | null =
          input.trustedCustomerReplyContext &&
          requestedCustomerWorkflow &&
          requestedCustomerWorkflow !==
            input.trustedCustomerReplyContext.workflow
            ? {
                success: false,
                code: "CUSTOMER_WORKFLOW_CONFLICT",
                message:
                  "The trusted quoted reply belongs to the customer's active order. Do not mutate an earlier order check-in from this message."
              }
            : completedCustomerWorkflowMutation &&
          requestedCustomerWorkflow &&
          completedCustomerWorkflowMutation !== requestedCustomerWorkflow
            ? {
                success: false,
                code: "CUSTOMER_WORKFLOW_CONFLICT",
                message:
                  "That message could refer to two active customer workflows. Ask whether the customer means the current order or the earlier order check-in before changing anything else."
              }
            : null;
        const trustedReferenceGuardResult = getTrustedOrderReferenceGuardResult(
          input,
          toolName,
          safeArguments
        );
        const marketingMutationGuardResult =
          getCustomerMarketingMutationIntentGuard(
            input,
            toolName,
            safeArguments,
            recentInactiveCampaignRequest
          );
        const result = toolCall.invalidArguments
          ? {
              success: false,
              code: "TOOL_INVALID_ARGUMENTS",
              message:
                "The tool arguments were malformed. Please retry the tool call with valid JSON arguments."
            }
          : permittedToolNames.has(toolName)
            ? workflowConflictResult ??
              trustedReferenceGuardResult ??
              marketingMutationGuardResult ??
              (await executeTool(
                toolName,
                safeArguments,
                toolExecutionContext
              ))
            : {
                success: false,
                code: "TOOL_FORBIDDEN",
                message: "That tool is not available for the current sender role."
              };

        if (
          result.success &&
          toolName === "list_customers"
        ) {
          const customerList = parseGroundedCustomerListResult(result.data);
          if (customerList) {
            latestCustomerList = customerList;
            latestCustomerListArgs = safeArguments;
          }
        }

        if (result.success && toolName === "get_customer_insights") {
          latestCustomerInsights =
            parseGroundedCustomerInsightsResult(result.data) ?? undefined;
        }

        if (result.success && toolName === "get_customer_segment_insights") {
          latestCustomerSegment =
            parseGroundedCustomerSegmentResult(result.data) ?? undefined;
        }

        if (result.success && toolName === "list_orders") {
          latestOrderList =
            parseGroundedOrderListResult(result.data) ?? undefined;
        }

        if (result.success && toolName === "get_business_report") {
          latestBusinessReport =
            parseGroundedBusinessReportResult(result.data) ?? undefined;
        }

        if (
          input.sender.role === "customer" &&
          toolName === "search_menu_items" &&
          safeArguments.includeImage === true &&
          !toolCall.invalidArguments &&
          permittedToolNames.has(toolName) &&
          !workflowConflictResult &&
          !trustedReferenceGuardResult
        ) {
          customerMenuMediaLookupPerformed = true;
        }

        if (result.success && requestedCustomerWorkflow) {
          completedCustomerWorkflowMutation = requestedCustomerWorkflow;
        }

        executedTools.push({
          name: toolName,
          success: result.success,
          code: result.code,
          message: result.message,
          requiresConfirmation: result.requiresConfirmation,
          pendingActionId: result.pendingActionId,
          ...getExecutedOrderMetadata(result.data)
        });
        importantData = getImportantData(
          importantData,
          result,
          toolName,
          safeArguments
        );

        await saveMessage({
          restaurantId,
          senderPhone: senderIdentityKey,
          senderRole: input.sender.role,
          direction: "tool",
          content: JSON.stringify(buildToolResultForModel(toolName, result)),
          metadata: {
            source: "openrouter_agent",
            provider: provider.name,
            model: provider.model,
            toolName,
            success: result.success,
            code: result.code,
            requiresConfirmation: result.requiresConfirmation,
            invalidArguments: toolCall.invalidArguments
          }
        });

        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          name: toolName,
          content: JSON.stringify(buildToolResultForModel(toolName, result))
        });

        if (
          result.success &&
          result.requiresConfirmation &&
          campaignConfirmationPreviewToolNames.has(toolName) &&
          result.message.trim()
        ) {
          const previewMessage = sanitizeStaffFacingFinalText(result.message);

          console.info("Restaurant agent completed", {
            provider: provider.name,
            model: provider.model,
            restaurantId,
            senderRole: input.sender.role,
            conversationKey,
            toolRoundCount: round + 1,
            requestedToolNames: executedTools.map((tool) => tool.name),
            completionReason: "authoritative_campaign_confirmation_preview",
            latencyMs: Date.now() - startedAt,
            totalTokens: usage?.totalTokens
          });

          return {
            success: true,
            message: previewMessage,
            data: importantData,
            provider: provider.name,
            model: provider.model,
            responseId,
            executedTools,
            usage
          };
        }
      }
    }

    const recoverableMessage = getRecoverableToolFallbackMessage(executedTools);

    return {
      success: false,
      message: recoverableMessage ?? maxRoundsFallbackMessage,
      data: importantData,
      provider: provider.name,
      model: provider.model,
      responseId,
      executedTools,
      usage
    };
  } catch (error) {
    const errorCode = classifyOrchestratorError(error);

    console.error("Restaurant agent orchestration failed", {
      provider: provider.name,
      model: provider.model,
      restaurantId,
      senderRole: input.sender.role,
      conversationKey,
      requestedToolNames: executedTools.map((tool) => tool.name),
      latencyMs: Date.now() - startedAt,
      errorCode,
      error: error instanceof Error ? error.message : "Unknown agent orchestration error"
    });

    return {
      success: false,
      message: safeFallbackMessage,
      data: importantData,
      errorCode,
      provider: provider.name,
      model: provider.model,
      responseId,
      executedTools,
      usage
    };
  }
};
