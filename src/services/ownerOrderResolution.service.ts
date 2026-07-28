import { Order, type IOrderDocument } from "../models/order.model";
import { PendingAgentAction } from "../models/pendingAgentAction.model";
import * as orderService from "./order.service";

export type OwnerOrderDecision = "accept" | "reject";

export interface OwnerOrderResolutionResult {
  handled: boolean;
  success: boolean;
  message: string;
  data?: {
    orders?: IOrderDocument[];
    order?: IOrderDocument;
    orderEvent?: "confirmed" | "rejected";
    notifyCustomer?: boolean;
    receiptRequired?: boolean;
    idempotent?: boolean;
    pendingActionId?: string;
  };
}

const selectionTtlMs = 5 * 60 * 1000;

const normalizeDecisionText = (message: string): string =>
  message.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();

export const parseSimpleOwnerDecision = (message: string): OwnerOrderDecision | null => {
  const normalized = normalizeDecisionText(message);

  if (/^(accept|accepted|confirm|confirmed)$/.test(normalized)) {
    return "accept";
  }

  if (/^(reject|rejected|decline|declined)$/.test(normalized)) {
    return "reject";
  }

  return null;
};

export const parseOwnerSelectionReply = (
  message: string,
  maxSelection: number
): { type: "cancel" } | { type: "all" } | { type: "indexes"; indexes: number[] } | null => {
  const normalized = normalizeDecisionText(message);

  if (normalized === "cancel" || normalized === "stop") {
    return { type: "cancel" };
  }

  if (normalized === "both" || normalized === "all") {
    return { type: "all" };
  }

  const indexes = normalized
    .split(/\s*(?:,|and|\s)\s*/)
    .map((part) => Number(part))
    .filter((value) => Number.isInteger(value) && value >= 1 && value <= maxSelection);

  return indexes.length > 0 ? { type: "indexes", indexes: Array.from(new Set(indexes)) } : null;
};

export const buildPendingOrderSummaryLine = (
  order: Pick<IOrderDocument, "customerName" | "items" | "subtotal" | "customerConfirmedAt" | "createdAt">,
  index: number,
  now = new Date()
): string => {
  const itemSummary = order.items
    .slice(0, 2)
    .map((item) => item.name)
    .join(", ");

  return `${index}. ${order.customerName || "Customer"} - ${itemSummary} - ${orderService.formatGhanaCedi(
    order.subtotal
  )} - ${orderService.formatRelativeOrderAge(order, now)}`;
};

export const buildOwnerSelectionMessage = (
  decision: OwnerOrderDecision,
  orders: IOrderDocument[],
  now = new Date()
): string => {
  const verb = decision === "accept" ? "accept" : "reject";

  return [
    `Which order should I ${verb}?`,
    "",
    ...orders.map((order, index) => buildPendingOrderSummaryLine(order, index + 1, now)),
    "",
    orders.length === 2 ? "Reply 1, 2, or both." : `Reply 1-${orders.length}, or all.`
  ].join("\n");
};

const getFreshPendingOrders = async (restaurantId: string): Promise<IOrderDocument[]> => {
  await orderService.expireOldPendingOrders(restaurantId);

  const orders = await Order.find({
    restaurantId,
    status: { $in: ["awaiting_restaurant_confirmation", "pending"] }
  }).sort({ customerConfirmedAt: 1, createdAt: 1 });

  return orders.filter((order) => orderService.isPendingOrderActionable(order));
};

const findPendingSelection = async (restaurantId: string, senderPhone: string) => {
  return PendingAgentAction.findOne({
    restaurantId,
    senderPhone,
    action: "OWNER_ORDER_SELECTION",
    status: "pending",
    expiresAt: { $gt: new Date() }
  }).sort({ createdAt: -1 });
};

const applyDecision = async (
  orderId: string,
  decision: OwnerOrderDecision,
  reason?: string
): Promise<Awaited<ReturnType<typeof orderService.confirmRestaurantOrder>>> => {
  return decision === "accept"
    ? orderService.confirmRestaurantOrder(orderId)
    : orderService.rejectRestaurantOrder(orderId, reason);
};

const formatDecisionDoneMessage = (
  order: IOrderDocument,
  decision: OwnerOrderDecision,
  idempotent: boolean
): string => {
  const name = order.customerName || "Customer";

  if (idempotent) {
    return `${name}'s order was already ${decision === "accept" ? "accepted" : "rejected"}.`;
  }

  return decision === "accept"
    ? `${name}'s order has been accepted. The customer will be notified.`
    : `${name}'s order has been rejected. The customer will be notified.`;
};

export const resolveQuotedOwnerOrderDecision = async (
  restaurantId: string,
  quotedMessageId: string | undefined,
  decision: OwnerOrderDecision,
  reason?: string
): Promise<OwnerOrderResolutionResult> => {
  if (!quotedMessageId) {
    return { handled: false, success: false, message: "" };
  }

  const order = await Order.findOne({
    restaurantId,
    ownerNotificationProviderMessageId: quotedMessageId
  });

  if (!order) {
    return { handled: false, success: false, message: "" };
  }

  const result = await applyDecision(String(order._id), decision, reason);

  return {
    handled: true,
    success: true,
    message: formatDecisionDoneMessage(result.order, decision, result.idempotent),
    data: {
      order: result.order,
      orderEvent: decision === "accept" ? "confirmed" : "rejected",
      notifyCustomer: true,
      receiptRequired: decision === "accept",
      idempotent: result.idempotent
    }
  };
};

export const handleSavedOwnerSelectionReply = async (
  restaurantId: string,
  senderPhone: string,
  message: string
): Promise<OwnerOrderResolutionResult> => {
  const pendingSelection = await findPendingSelection(restaurantId, senderPhone);

  if (!pendingSelection) {
    return { handled: false, success: false, message: "" };
  }

  const orderIds = Array.isArray(pendingSelection.data.orderIds)
    ? pendingSelection.data.orderIds.map(String)
    : [];
  const decision = pendingSelection.data.decision === "reject" ? "reject" : "accept";
  const reply = parseOwnerSelectionReply(message, orderIds.length);

  if (!reply) {
    return { handled: false, success: false, message: "" };
  }

  if (reply.type === "cancel") {
    pendingSelection.status = "cancelled";
    pendingSelection.resultMessage = "Order selection cancelled.";
    await pendingSelection.save();

    return {
      handled: true,
      success: true,
      message: "Okay, I cancelled that order selection."
    };
  }

  const selectedIds =
    reply.type === "all" ? orderIds : reply.indexes.map((index) => orderIds[index - 1]).filter(Boolean);
  const succeeded: IOrderDocument[] = [];
  const failed: string[] = [];

  for (const orderId of selectedIds) {
    try {
      const result = await applyDecision(orderId, decision);
      succeeded.push(result.order);
    } catch (error) {
      failed.push(error instanceof Error ? error.message : `Order ${orderId} failed`);
    }
  }

  pendingSelection.status = failed.length === 0 ? "completed" : "failed";
  pendingSelection.resultMessage = `${succeeded.length} order(s) ${decision === "accept" ? "accepted" : "rejected"}.`;
  pendingSelection.errorMessage = failed.join("; ") || undefined;
  await pendingSelection.save();

  return {
    handled: true,
    success: failed.length === 0,
    message:
      failed.length === 0
        ? `${succeeded.length} order${succeeded.length === 1 ? "" : "s"} ${
            decision === "accept" ? "accepted" : "rejected"
          }. The customer${succeeded.length === 1 ? "" : "s"} will be notified.`
        : `${succeeded.length} order${succeeded.length === 1 ? "" : "s"} ${
            decision === "accept" ? "accepted" : "rejected"
          }, but ${failed.length} failed: ${failed.join("; ")}`,
    data: {
      orders: succeeded,
      orderEvent: decision === "accept" ? "confirmed" : "rejected",
      notifyCustomer: true,
      receiptRequired: decision === "accept"
    }
  };
};

export const handleUnquotedOwnerOrderDecision = async (
  restaurantId: string,
  senderPhone: string,
  decision: OwnerOrderDecision
): Promise<OwnerOrderResolutionResult> => {
  const freshOrders = await getFreshPendingOrders(restaurantId);

  if (freshOrders.length === 0) {
    return {
      handled: true,
      success: false,
      message: "There are no fresh pending orders to act on."
    };
  }

  if (freshOrders.length === 1) {
    const result = await applyDecision(String(freshOrders[0]._id), decision);

    return {
      handled: true,
      success: true,
      message: formatDecisionDoneMessage(result.order, decision, result.idempotent),
      data: {
        order: result.order,
        orderEvent: decision === "accept" ? "confirmed" : "rejected",
        notifyCustomer: true,
        receiptRequired: decision === "accept",
        idempotent: result.idempotent
      }
    };
  }

  const pendingSelection = await PendingAgentAction.create({
    restaurantId,
    senderPhone,
    senderRole: "owner",
    action: "OWNER_ORDER_SELECTION",
    data: {
      decision,
      orderIds: freshOrders.map((order) => String(order._id))
    },
    status: "pending",
    confirmationMessage: buildOwnerSelectionMessage(decision, freshOrders),
    expiresAt: new Date(Date.now() + selectionTtlMs)
  });

  return {
    handled: true,
    success: true,
    message: pendingSelection.confirmationMessage,
    data: {
      pendingActionId: String(pendingSelection._id)
    }
  };
};
