import type { IRestaurantDocument } from "../models/Restaurant";
import type { ResolvedSender } from "../types/agent.types";
import { normalizeGhanaPhone } from "../utils/phone.util";

const normalizePhone = (phone?: string): string => {
  return phone ? normalizeGhanaPhone(phone) : "";
};

export const resolveSenderIdentity = (
  restaurant: IRestaurantDocument,
  senderPhone: string
): ResolvedSender => {
  const normalizedPhone = normalizePhone(senderPhone);

  if (normalizedPhone && normalizedPhone === normalizePhone(restaurant.ownerPhone)) {
    return {
      name: restaurant.ownerName,
      phone: senderPhone,
      normalizedPhone,
      role: "owner",
      verified: true
    };
  }

  const managerContact = restaurant.managerContacts.find(
    (manager) => normalizePhone(manager.phone) === normalizedPhone
  );

  if (managerContact) {
    return {
      name: managerContact.name,
      phone: senderPhone,
      normalizedPhone,
      role: "manager",
      verified: true
    };
  }

  if (restaurant.managerPhones.map(normalizePhone).includes(normalizedPhone)) {
    return {
      phone: senderPhone,
      normalizedPhone,
      role: "manager",
      verified: true
    };
  }

  return {
    phone: senderPhone,
    normalizedPhone,
    role: "customer",
    verified: false
  };
};
