import { Order, type IOrderDocument } from "../models/order.model";
import { OutboundMessage } from "../models/outboundMessage.model";
import type { ResolvedSender } from "../types/agent.types";
import { normalizeGhanaPhone } from "../utils/phone.util";

export type QuotedOwnerOrderAction = "order_decision" | "cancellation_request";

export interface TrustedQuotedOwnerOrderContext {
  order: IOrderDocument;
  action: QuotedOwnerOrderAction;
  expectedAmendmentVersion?: number;
  currentAmendmentVersion: number;
  stale: boolean;
}

const actionableKinds = [
  "owner_order_notification",
  "owner_order_amended_notification",
  "owner_order_cancellation_request_notification",
  "staff_order_notification",
  "staff_order_amended_notification",
  "staff_order_cancellation_request_notification"
] as const;

export const findTrustedQuotedOwnerOrderContext = async (
  restaurantId: string,
  providerMessageId: string,
  sender?: Pick<ResolvedSender, "normalizedPhone" | "role">
): Promise<TrustedQuotedOwnerOrderContext | null> => {
  const legacyOrder =
    !sender || sender.role === "owner"
      ? await Order.findOne({
          restaurantId,
          ownerNotificationProviderMessageId: providerMessageId
        })
      : null;
  if (legacyOrder) {
    const currentAmendmentVersion = legacyOrder.customerAmendmentVersion ?? 0;
    return {
      order: legacyOrder,
      action: "order_decision",
      expectedAmendmentVersion: 0,
      currentAmendmentVersion,
      stale: currentAmendmentVersion !== 0
    };
  }

  const queuedMessage = await OutboundMessage.findOne({
    restaurantId,
    providerMessageId,
    status: "sent",
    "metadata.kind": { $in: [...actionableKinds] }
  });
  const queuedOrderId =
    typeof queuedMessage?.metadata?.orderId === "string"
      ? queuedMessage.metadata.orderId
      : undefined;

  const intendedRecipient =
    typeof queuedMessage?.metadata?.recipientPhone === "string"
      ? normalizeGhanaPhone(queuedMessage.metadata.recipientPhone)
      : "";
  const senderPhone = sender
    ? normalizeGhanaPhone(sender.normalizedPhone)
    : "";

  if (
    queuedMessage &&
    sender &&
    (intendedRecipient
      ? intendedRecipient !== senderPhone
      : sender.role !== "owner")
  ) {
    return null;
  }

  if (queuedMessage && queuedOrderId) {
    const order = await Order.findOne({ _id: queuedOrderId, restaurantId });
    if (!order) {
      return null;
    }

    const kind = queuedMessage.metadata?.kind;
    const action: QuotedOwnerOrderAction =
      kind === "owner_order_cancellation_request_notification" ||
      kind === "staff_order_cancellation_request_notification"
        ? "cancellation_request"
        : "order_decision";
    const expectedVersion = Number(queuedMessage.metadata?.amendmentVersion);
    const expectedAmendmentVersion =
      action === "order_decision" &&
      Number.isInteger(expectedVersion) &&
      expectedVersion >= 0
        ? expectedVersion
        : undefined;
    const currentAmendmentVersion = order.customerAmendmentVersion ?? 0;

    return {
      order,
      action,
      expectedAmendmentVersion,
      currentAmendmentVersion,
      stale:
        action === "order_decision" &&
        expectedAmendmentVersion !== currentAmendmentVersion
    };
  }

  return null;
};
