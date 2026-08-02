import { Types } from "mongoose";
import { OrderFeedback } from "../models/orderFeedback.model";
import {
  Order,
  type IOrderDocument,
  type OrderCompletionSource,
  type OrderStatus
} from "../models/order.model";
import { OutboundMessage } from "../models/outboundMessage.model";
import { Restaurant } from "../models/Restaurant";
import { BadRequestError, NotFoundError } from "../utils/httpErrors";
import { normalizeGhanaPhone } from "../utils/phone.util";
import { updateCustomerProfileFromCompletedOrder } from "./customerProfile.service";

export const feedbackCompletionEligibleStatuses: OrderStatus[] = [
  "accepted",
  "confirmed",
  "preparing",
  "ready",
  "out_for_delivery"
];

const feedbackMessageKinds = [
  "order_feedback_request",
  "order_feedback_reminder"
];

export interface CompleteOrderThroughFeedbackInput {
  restaurantId: string;
  orderId: string;
  completionSource: OrderCompletionSource;
  completionConfirmedByCustomer: boolean;
  completedAt?: Date;
}

export interface CompleteOrderThroughFeedbackResult {
  order: IOrderDocument;
  idempotent: boolean;
  customerProfileUpdated: boolean;
}

export interface OrderCompletionDependencies {
  hasUnresolvedDeliveryNotReceived?: (
    restaurantId: string,
    orderId: string
  ) => Promise<boolean>;
  updateCustomerProfile?: typeof updateCustomerProfileFromCompletedOrder;
  cancelQueuedMessages?: typeof cancelQueuedOrderFeedbackMessages;
  isRestaurantActive?: (restaurantId: string) => Promise<boolean>;
}

const ensureObjectId = (value: string, fieldName: string): void => {
  if (!Types.ObjectId.isValid(value)) {
    throw new BadRequestError(`Invalid ${fieldName}`);
  }
};

export const hasUnresolvedDeliveryNotReceivedFeedback = async (
  restaurantId: string,
  orderId: string
): Promise<boolean> => {
  const unresolved = await OrderFeedback.exists({
    restaurantId,
    orderId,
    type: "delivery_not_received",
    resolvedAt: { $exists: false }
  });

  return Boolean(unresolved);
};

export const cancelQueuedOrderFeedbackMessages = async (
  restaurantId: string,
  orderId: string,
  reason: string
): Promise<number> => {
  const result = await OutboundMessage.updateMany(
    {
      restaurantId,
      status: "pending",
      "metadata.orderId": orderId,
      "metadata.kind": { $in: feedbackMessageKinds }
    },
    {
      $set: {
        status: "cancelled",
        lastError: reason
      }
    }
  );

  return result.modifiedCount;
};

const getFollowUpStatusForCompletion = (
  source: OrderCompletionSource
): "answered" | "automatically_closed" | "cancelled" => {
  if (source === "automatic_timeout") {
    return "automatically_closed";
  }

  if (source === "owner_manual") {
    return "cancelled";
  }

  return "answered";
};

export const completeOrderThroughFeedback = async (
  input: CompleteOrderThroughFeedbackInput,
  dependencies: OrderCompletionDependencies = {}
): Promise<CompleteOrderThroughFeedbackResult> => {
  ensureObjectId(input.restaurantId, "restaurantId");
  ensureObjectId(input.orderId, "orderId");

  const current = await Order.findOne({
    _id: input.orderId,
    restaurantId: input.restaurantId
  });

  if (!current) {
    throw new NotFoundError("Order not found");
  }

  if (current.status === "completed") {
    return {
      order: current,
      idempotent: true,
      customerProfileUpdated: false
    };
  }

  if (!feedbackCompletionEligibleStatuses.includes(current.status)) {
    throw new BadRequestError(
      `Order cannot be completed from status ${current.status}`,
      "ORDER_NOT_COMPLETABLE"
    );
  }

  if (input.completionSource === "automatic_timeout") {
    const isRestaurantActive = dependencies.isRestaurantActive
      ? await dependencies.isRestaurantActive(input.restaurantId)
      : Boolean(
          await Restaurant.exists({
            _id: input.restaurantId,
            status: { $in: ["trial", "active"] }
          })
        );

    if (!isRestaurantActive) {
      throw new BadRequestError(
        "Automatic completion is disabled for an inactive restaurant",
        "ORDER_AUTO_COMPLETION_BLOCKED"
      );
    }
  }

  if (
    input.completionSource === "automatic_timeout" &&
    (current.feedbackFollowUpStatus === "issue_reported" ||
      (await (
        dependencies.hasUnresolvedDeliveryNotReceived ??
        hasUnresolvedDeliveryNotReceivedFeedback
      )(
        input.restaurantId,
        input.orderId
      )))
  ) {
    throw new BadRequestError(
      "Automatic completion is blocked by an unresolved non-delivery report",
      "ORDER_AUTO_COMPLETION_BLOCKED"
    );
  }

  const now = input.completedAt ?? new Date();
  const normalizedPhone = normalizeGhanaPhone(current.customerPhone);
  const updated = await Order.findOneAndUpdate(
    {
      _id: input.orderId,
      restaurantId: input.restaurantId,
      status: { $in: feedbackCompletionEligibleStatuses }
    },
    {
      $set: {
        status: "completed",
        completedAt: current.completedAt ?? now,
        completionSource: input.completionSource,
        completionConfirmedByCustomer:
          input.completionConfirmedByCustomer,
        customerPhone: normalizedPhone,
        feedbackFollowUpStatus: getFollowUpStatusForCompletion(
          input.completionSource
        ),
        feedbackAwaitingComplaint: false,
        feedbackReceiptClarificationPending: false,
        ...(input.completionConfirmedByCustomer
          ? {
              customerConfirmedReceiptAt:
                current.customerConfirmedReceiptAt ?? now
            }
          : {})
      }
    },
    {
      new: true,
      runValidators: true
    }
  );

  if (!updated) {
    const concurrentlyCompleted = await Order.findOne({
      _id: input.orderId,
      restaurantId: input.restaurantId
    });

    if (concurrentlyCompleted?.status === "completed") {
      return {
        order: concurrentlyCompleted,
        idempotent: true,
        customerProfileUpdated: false
      };
    }

    throw new BadRequestError(
      "Order could not be completed in its current state",
      "ORDER_NOT_COMPLETABLE"
    );
  }

  let customerProfileUpdated = false;

  if (!updated.completionProfileUpdatedAt) {
    await (
      dependencies.updateCustomerProfile ??
      updateCustomerProfileFromCompletedOrder
    )(updated);
    const profileUpdatedAt = new Date();
    await Order.updateOne(
      {
        _id: input.orderId,
        restaurantId: input.restaurantId,
        completionProfileUpdatedAt: { $exists: false }
      },
      {
        $set: { completionProfileUpdatedAt: profileUpdatedAt }
      }
    );
    updated.completionProfileUpdatedAt = profileUpdatedAt;
    customerProfileUpdated = true;
  }

  await (
    dependencies.cancelQueuedMessages ??
    cancelQueuedOrderFeedbackMessages
  )(
    input.restaurantId,
    input.orderId,
    `Order completed via ${input.completionSource}`
  );

  return {
    order: updated,
    idempotent: false,
    customerProfileUpdated
  };
};
