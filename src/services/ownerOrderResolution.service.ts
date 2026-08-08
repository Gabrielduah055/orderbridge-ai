import { Types } from "mongoose";
import { Order, type IOrderDocument } from "../models/order.model";
import { PendingAgentAction } from "../models/pendingAgentAction.model";
import type { SenderRole } from "../types/agent.types";
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

export interface AwaitingRejectionSelectionReconciliation {
  completed: boolean;
  remainingOrderIds: string[];
  updated: boolean;
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

  if (
    normalized === "cancel" ||
    normalized === "stop" ||
    normalized === "never mind" ||
    normalized === "nevermind"
  ) {
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

const findPendingSelection = async (
  restaurantId: string,
  senderPhone: string,
  senderRole?: Extract<SenderRole, "owner" | "manager">
) => {
  return PendingAgentAction.findOne({
    restaurantId,
    senderPhone,
    ...(senderRole ? { senderRole } : {}),
    action: "OWNER_ORDER_SELECTION",
    status: "pending",
    expiresAt: { $gt: new Date() }
  }).sort({ createdAt: -1 });
};

const orderReference = (order: IOrderDocument): string =>
  order.orderNumber || String(order._id);

const buildRejectionReasonQuestion = (orders: IOrderDocument[]): string =>
  orders.length === 1
    ? `What's the reason for rejecting ${orderReference(orders[0])}?`
    : orders.length > 1
      ? `What's the reason for rejecting these ${orders.length} orders?`
      : "What's the reason for rejecting that order?";

const createOwnerOrderSelection = async (input: {
  restaurantId: string;
  senderPhone: string;
  senderRole: Extract<SenderRole, "owner" | "manager">;
  decision: OwnerOrderDecision;
  orders: IOrderDocument[];
  awaitingReason?: boolean;
  reason?: string;
  confirmationMessage: string;
}) => {
  return PendingAgentAction.create({
    restaurantId: input.restaurantId,
    senderPhone: input.senderPhone,
    senderRole: input.senderRole,
    action: "OWNER_ORDER_SELECTION",
    data: {
      decision: input.decision,
      orderIds: input.orders.map((order) => String(order._id)),
      awaitingReason: input.awaitingReason ?? false,
      ...(input.reason ? { reason: input.reason } : {})
    },
    status: "pending",
    confirmationMessage: input.confirmationMessage,
    expiresAt: new Date(Date.now() + selectionTtlMs)
  });
};

export const requestOwnerOrderRejectionReason = async (input: {
  restaurantId: string;
  senderPhone: string;
  senderRole: Extract<SenderRole, "owner" | "manager">;
  orderReference: string;
}): Promise<OwnerOrderResolutionResult> => {
  const reference = input.orderReference.trim();
  const order = await Order.findOne({
    restaurantId: input.restaurantId,
    ...(Types.ObjectId.isValid(reference)
      ? { _id: reference }
      : { orderNumber: reference })
  });

  if (!order) {
    return {
      handled: true,
      success: false,
      message: "I couldn't find that order for this restaurant."
    };
  }

  if (
    !["awaiting_restaurant_confirmation", "pending"].includes(order.status) ||
    !orderService.isPendingOrderActionable(order)
  ) {
    return {
      handled: true,
      success: false,
      message: "That order cannot be rejected in its current state."
    };
  }

  const message = buildRejectionReasonQuestion([order]);
  const pendingSelection = await createOwnerOrderSelection({
    restaurantId: input.restaurantId,
    senderPhone: input.senderPhone,
    senderRole: input.senderRole,
    decision: "reject",
    orders: [order],
    awaitingReason: true,
    confirmationMessage: message
  });

  return {
    handled: true,
    success: true,
    message,
    data: { pendingActionId: String(pendingSelection._id) }
  };
};

export const reconcileAwaitingOwnerRejectionSelection = async (input: {
  restaurantId: string;
  senderPhone: string;
  senderRole: Extract<SenderRole, "owner" | "manager">;
  pendingActionId: string;
  expectedOrderIds: string[];
  successfulOrderIds: string[];
}): Promise<AwaitingRejectionSelectionReconciliation> => {
  const expectedOrderIds = Array.from(
    new Set(input.expectedOrderIds.map(String).filter(Boolean))
  );
  const expectedOrderIdSet = new Set(expectedOrderIds);
  const successfulOrderIds = Array.from(
    new Set(
      input.successfulOrderIds
        .map(String)
        .filter((orderId) => expectedOrderIdSet.has(orderId))
    )
  );
  const successfulOrderIdSet = new Set(successfulOrderIds);
  const remainingOrderIds = expectedOrderIds.filter(
    (orderId) => !successfulOrderIdSet.has(orderId)
  );

  if (expectedOrderIds.length === 0 || successfulOrderIds.length === 0) {
    return {
      completed: false,
      remainingOrderIds: expectedOrderIds,
      updated: false
    };
  }

  const exactSelectionScope = {
    _id: input.pendingActionId,
    restaurantId: input.restaurantId,
    senderPhone: input.senderPhone,
    senderRole: input.senderRole,
    action: "OWNER_ORDER_SELECTION",
    expiresAt: { $gt: new Date() },
    "data.decision": "reject",
    "data.awaitingReason": true,
    "data.orderIds": { $size: expectedOrderIds.length, $all: expectedOrderIds }
  };

  if (remainingOrderIds.length === 0) {
    const updateResult = await PendingAgentAction.updateOne(
      { ...exactSelectionScope, status: "pending" },
      {
        $set: {
          status: "completed",
          completedAt: new Date(),
          resultMessage: `${expectedOrderIds.length} order(s) rejected.`
        },
        $unset: { errorMessage: 1 },
        $inc: { actionVersion: 1 }
      }
    );

    if (updateResult.matchedCount > 0) {
      return { completed: true, remainingOrderIds: [], updated: true };
    }

    const alreadyCompleted = await PendingAgentAction.exists({
      ...exactSelectionScope,
      status: "completed"
    });

    return {
      completed: Boolean(alreadyCompleted),
      remainingOrderIds: [],
      updated: false
    };
  }

  const updateResult = await PendingAgentAction.updateOne(
    { ...exactSelectionScope, status: "pending" },
    {
      $set: {
        "data.orderIds": remainingOrderIds,
        confirmationMessage:
          remainingOrderIds.length === 1
            ? "Please provide the rejection reason again for the remaining order."
            : `Please provide the rejection reason again for the ${remainingOrderIds.length} remaining orders.`,
        resultMessage: `${successfulOrderIds.length} order(s) rejected; ${remainingOrderIds.length} still pending.`
      },
      $unset: { errorMessage: 1 },
      $inc: { actionVersion: 1 }
    }
  );

  return {
    completed: false,
    remainingOrderIds,
    updated: updateResult.matchedCount > 0
  };
};

const applyDecision = async (
  restaurantId: string,
  orderId: string,
  decision: OwnerOrderDecision,
  reason?: string
): Promise<Awaited<ReturnType<typeof orderService.confirmRestaurantOrder>>> => {
  return decision === "accept"
    ? orderService.confirmRestaurantOrder(orderId, restaurantId)
    : orderService.rejectRestaurantOrder(orderId, reason, restaurantId);
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
  reason?: string,
  senderPhone?: string,
  senderRole: Extract<SenderRole, "owner" | "manager"> = "owner"
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

  if (decision === "reject" && !reason?.trim()) {
    if (senderPhone) {
      return requestOwnerOrderRejectionReason({
        restaurantId,
        senderPhone,
        senderRole,
        orderReference: String(order._id)
      });
    }

    const message = buildRejectionReasonQuestion([order]);

    return {
      handled: true,
      success: true,
      message
    };
  }

  const result = await applyDecision(restaurantId, String(order._id), decision, reason);

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
  message: string,
  senderRole?: Extract<SenderRole, "owner" | "manager">
): Promise<OwnerOrderResolutionResult> => {
  const pendingSelection = await findPendingSelection(
    restaurantId,
    senderPhone,
    senderRole
  );

  if (!pendingSelection) {
    return { handled: false, success: false, message: "" };
  }

  const orderIds = Array.isArray(pendingSelection.data.orderIds)
    ? pendingSelection.data.orderIds.map(String)
    : [];
  const decision = pendingSelection.data.decision === "reject" ? "reject" : "accept";
  const reply = parseOwnerSelectionReply(message, orderIds.length);

  if (pendingSelection.data.awaitingReason === true) {
    if (reply?.type === "cancel") {
      pendingSelection.status = "cancelled";
      pendingSelection.resultMessage = "Order rejection cancelled.";
      await pendingSelection.save();

      return {
        handled: true,
        success: true,
        message: "Okay, I cancelled that order rejection."
      };
    }

    // Natural-language rejection reasons are intentionally left to the AI tool
    // path. The deterministic selection fallback must never infer that arbitrary
    // conversational text is a reason and reject an order on its own.
    return { handled: false, success: false, message: "" };
  }

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
  const selectedOrders = await Order.find({
    restaurantId,
    _id: { $in: selectedIds }
  });

  if (decision === "reject" && !pendingSelection.data.reason) {
    pendingSelection.data = {
      ...pendingSelection.data,
      orderIds: selectedIds,
      awaitingReason: true
    };
    pendingSelection.confirmationMessage = buildRejectionReasonQuestion(selectedOrders);
    pendingSelection.actionVersion += 1;
    await pendingSelection.save();

    return {
      handled: true,
      success: true,
      message: pendingSelection.confirmationMessage,
      data: { pendingActionId: String(pendingSelection._id) }
    };
  }
  const succeeded: IOrderDocument[] = [];
  const failed: string[] = [];

  for (const orderId of selectedIds) {
    try {
      const result = await applyDecision(
        restaurantId,
        orderId,
        decision,
        typeof pendingSelection.data.reason === "string"
          ? pendingSelection.data.reason
          : undefined
      );
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
  decision: OwnerOrderDecision,
  senderRole: Extract<SenderRole, "owner" | "manager"> = "owner",
  reason?: string
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
    if (decision === "reject" && !reason?.trim()) {
      const message = buildRejectionReasonQuestion(freshOrders);
      const pendingSelection = await createOwnerOrderSelection({
        restaurantId,
        senderPhone,
        senderRole,
        decision,
        orders: freshOrders,
        awaitingReason: true,
        confirmationMessage: message
      });

      return {
        handled: true,
        success: true,
        message,
        data: { pendingActionId: String(pendingSelection._id) }
      };
    }

    const result = await applyDecision(
      restaurantId,
      String(freshOrders[0]._id),
      decision,
      reason
    );

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

  const pendingSelection = await createOwnerOrderSelection({
    restaurantId,
    senderPhone,
    senderRole,
    decision,
    orders: freshOrders,
    reason: reason?.trim(),
    confirmationMessage: buildOwnerSelectionMessage(decision, freshOrders)
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
