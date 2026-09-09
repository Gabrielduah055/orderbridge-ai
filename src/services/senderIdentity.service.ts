import type { IRestaurantDocument } from "../models/Restaurant";
import type { ResolvedSender } from "../types/agent.types";
import {
  normalizeGhanaPhone,
  normalizeWhatsappRecipient
} from "../utils/phone.util";

type RestaurantIdentitySource = Pick<
  IRestaurantDocument,
  "ownerName" | "ownerPhone" | "managerPhones" | "managerContacts"
>;

const normalizePhone = (phone?: string): string => {
  return phone ? normalizeGhanaPhone(phone) : "";
};

export const resolveSenderIdentity = (
  restaurant: RestaurantIdentitySource,
  senderPhone: string,
  customerIdentity?: { customerKey?: string; recipientAddress?: string }
): ResolvedSender => {
  const normalizedPhone = normalizePhone(senderPhone);
  const normalizedAddress = normalizeWhatsappRecipient(senderPhone);

  if (normalizedPhone && normalizedPhone === normalizePhone(restaurant.ownerPhone)) {
    return {
      name: restaurant.ownerName,
      phone: senderPhone,
      normalizedAddress: normalizedPhone,
      normalizedPhone,
      role: "owner",
      verified: true
    };
  }

  const managerContact = restaurant.managerContacts.find(
    (manager) =>
      Boolean(normalizedPhone) && normalizePhone(manager.phone) === normalizedPhone
  );

  if (managerContact) {
    return {
      name: managerContact.name,
      phone: senderPhone,
      normalizedAddress: normalizedPhone,
      normalizedPhone,
      role: "manager",
      verified: true
    };
  }

  if (
    normalizedPhone &&
    restaurant.managerPhones.map(normalizePhone).includes(normalizedPhone)
  ) {
    return {
      phone: senderPhone,
      normalizedAddress: normalizedPhone,
      normalizedPhone,
      role: "manager",
      verified: true
    };
  }

  return {
    phone: senderPhone,
    normalizedAddress,
    // Kept for compatibility with existing customer-key call sites. Staff
    // authorization above only compares phone-normalized values.
    normalizedPhone: normalizedAddress,
    customerKey: customerIdentity?.customerKey || normalizedAddress,
    recipientAddress:
      normalizeWhatsappRecipient(customerIdentity?.recipientAddress) ||
      normalizedAddress,
    role: "customer",
    verified: false
  };
};
