import type { FilterQuery } from "mongoose";
import type { IOrderDocument } from "../models/order.model";
import { CustomerChannelIdentity } from "../models/customerChannelIdentity.model";
import { CustomerProfile } from "../models/customerProfile.model";
import { CustomerSession } from "../models/customerSession.model";
import {
  isWhatsappPhoneAddress,
  isWhatsappUsername,
  isValidWhatsappRecipient,
  normalizeWhatsappRecipient
} from "../utils/phone.util";

const WASENDER_LID_KEY_PREFIX = "wasender:lid:";

export type WhatsappRecipientResolutionReason =
  | "current_phone"
  | "current_username"
  | "legacy_phone_fallback"
  | "direct_recipient"
  | "stale_username"
  | "no_routable_address";

export interface WhatsappRecipientResolution {
  recipient?: string;
  resolved: boolean;
  reason: WhatsappRecipientResolutionReason;
}

export interface CustomerIdentityReference {
  customerKey?: string;
  recipientAddress: string;
}

export const normalizeCustomerKey = (
  customerKey: string | undefined,
  fallbackAddress: string
): string => {
  const key = customerKey?.trim().toLowerCase();

  if (key?.startsWith(WASENDER_LID_KEY_PREFIX)) {
    const lid = key.slice(WASENDER_LID_KEY_PREFIX.length);
    return /^\d+@lid$/.test(lid) ? `${WASENDER_LID_KEY_PREFIX}${lid}` : "";
  }

  return normalizeWhatsappRecipient(key || fallbackAddress);
};

export const getCustomerIdentityKey = (
  customerKey: string | undefined,
  recipientAddress: string
): string =>
  normalizeCustomerKey(customerKey, recipientAddress) ||
  normalizeWhatsappRecipient(recipientAddress);

export const canUseLegacyRecipientFallback = (
  recipientAddress: string
): boolean => isWhatsappPhoneAddress(recipientAddress);

export const getCustomerIdentityFilter = <T>(
  restaurantId: string,
  recipientAddress: string,
  customerKey?: string
): FilterQuery<T> => {
  const recipient = normalizeWhatsappRecipient(recipientAddress);
  const stableKey = normalizeCustomerKey(customerKey, recipient);

  if (stableKey && stableKey !== recipient) {
    if (!canUseLegacyRecipientFallback(recipient)) {
      return { restaurantId, customerKey: stableKey } as FilterQuery<T>;
    }

    return {
      restaurantId,
      $or: [
        { customerKey: stableKey },
        {
          customerKey: { $exists: false },
          customerPhone: recipient
        }
      ]
    } as FilterQuery<T>;
  }

  return { restaurantId, customerPhone: recipient } as FilterQuery<T>;
};

export const isOrderOwnedByCustomer = (
  order: Pick<IOrderDocument, "customerKey" | "customerPhone">,
  recipientAddress: string,
  customerKey?: string
): boolean => {
  const senderKey = normalizeCustomerKey(customerKey, recipientAddress);
  const orderKey = order.customerKey?.trim().toLowerCase();

  if (senderKey && orderKey) {
    return senderKey === orderKey;
  }

  if (
    senderKey.startsWith(WASENDER_LID_KEY_PREFIX) &&
    isWhatsappUsername(recipientAddress)
  ) {
    // A mutable username cannot prove ownership of a legacy order that has no
    // stable key. This prevents a newly assigned LID from claiming it.
    return false;
  }

  return (
    normalizeWhatsappRecipient(order.customerPhone) ===
    normalizeWhatsappRecipient(recipientAddress)
  );
};

export const resolveCurrentWhatsappRecipientResult = async (input: {
  restaurantId: string;
  customerKey?: string;
  fallbackAddress: string;
}): Promise<WhatsappRecipientResolution> => {
  const fallback = normalizeWhatsappRecipient(input.fallbackAddress);
  const key = normalizeCustomerKey(input.customerKey, fallback);

  if (!key.startsWith(WASENDER_LID_KEY_PREFIX)) {
    return isValidWhatsappRecipient(fallback)
      ? { recipient: fallback, resolved: true, reason: "direct_recipient" }
      : { resolved: false, reason: "no_routable_address" };
  }

  const lid = key.slice(WASENDER_LID_KEY_PREFIX.length);

  try {
    const identity = await CustomerChannelIdentity.findOne({
      restaurantId: input.restaurantId,
      provider: "wasender",
      channel: "whatsapp",
      lid
    }).select("phone username");
    const currentPhone = normalizeWhatsappRecipient(identity?.phone);
    if (isWhatsappPhoneAddress(currentPhone)) {
      return {
        recipient: currentPhone,
        resolved: true,
        reason: "current_phone"
      };
    }

    const currentUsername = normalizeWhatsappRecipient(identity?.username);
    if (isWhatsappUsername(currentUsername)) {
      return {
        recipient: currentUsername,
        resolved: true,
        reason: "current_username"
      };
    }

    if (canUseLegacyRecipientFallback(fallback)) {
      return {
        recipient: fallback,
        resolved: true,
        reason: "legacy_phone_fallback"
      };
    }

    return {
      resolved: false,
      reason: isWhatsappUsername(fallback)
        ? "stale_username"
        : "no_routable_address"
    };
  } catch {
    return canUseLegacyRecipientFallback(fallback)
      ? {
          recipient: fallback,
          resolved: true,
          reason: "legacy_phone_fallback"
        }
      : {
          resolved: false,
          reason: isWhatsappUsername(fallback)
            ? "stale_username"
            : "no_routable_address"
        };
  }
};

export const resolveCurrentWhatsappRecipient = async (input: {
  restaurantId: string;
  customerKey?: string;
  fallbackAddress: string;
}): Promise<string> =>
  (await resolveCurrentWhatsappRecipientResult(input)).recipient ?? "";

export const syncCurrentCustomerRecipient = async (input: {
  restaurantId: string;
  customerKey?: string;
  recipientAddress: string;
}): Promise<void> => {
  const recipient = normalizeWhatsappRecipient(input.recipientAddress);
  const customerKey = normalizeCustomerKey(input.customerKey, recipient);

  if (!recipient || !customerKey || customerKey === recipient) {
    return;
  }

  // Only records already bound to the stable key are updated. We never attach
  // a legacy record based solely on a mutable/reusable username.
  await Promise.allSettled([
    CustomerSession.updateOne(
      { restaurantId: input.restaurantId, customerKey },
      { $set: { customerPhone: recipient } }
    ),
    CustomerProfile.updateOne(
      { restaurantId: input.restaurantId, customerKey },
      { $set: { customerPhone: recipient } }
    )
  ]);
};
