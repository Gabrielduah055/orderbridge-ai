import type { IRestaurantDocument } from "../models/Restaurant";
import type { SenderRole } from "../types/agent.types";
import {
  isWhatsappPhoneAddress,
  normalizeGhanaPhone
} from "../utils/phone.util";

type OperationalRecipientRestaurant = Pick<
  IRestaurantDocument,
  "ownerName" | "ownerPhone" | "managerPhones" | "managerContacts"
>;

export interface StaffNotificationRecipient {
  recipientType: Extract<SenderRole, "owner" | "manager">;
  recipientPhone: string;
  recipientName?: string;
}

const normalizedRecipient = (
  phone: string | undefined,
  recipientType: StaffNotificationRecipient["recipientType"],
  recipientName?: string
): StaffNotificationRecipient | null => {
  const recipientPhone = phone ? normalizeGhanaPhone(phone) : "";
  if (!isWhatsappPhoneAddress(recipientPhone)) {
    return null;
  }

  const name = recipientName?.trim().replace(/\s+/g, " ");
  return {
    recipientType,
    recipientPhone,
    ...(name ? { recipientName: name } : {})
  };
};

export const resolveOwnerNotificationRecipient = (
  restaurant: OperationalRecipientRestaurant
): StaffNotificationRecipient | null =>
  normalizedRecipient(
    restaurant.ownerPhone,
    "owner",
    restaurant.ownerName
  );

/** Managers receive routine operations; the owner is used only as fallback. */
export const resolveOperationalRecipients = (
  restaurant: OperationalRecipientRestaurant
): StaffNotificationRecipient[] => {
  const recipientsByPhone = new Map<string, StaffNotificationRecipient>();

  for (const contact of restaurant.managerContacts ?? []) {
    const recipient = normalizedRecipient(
      contact.phone,
      "manager",
      contact.name
    );
    if (recipient) {
      recipientsByPhone.set(recipient.recipientPhone, recipient);
    }
  }

  for (const phone of restaurant.managerPhones ?? []) {
    const recipient = normalizedRecipient(phone, "manager");
    if (recipient && !recipientsByPhone.has(recipient.recipientPhone)) {
      recipientsByPhone.set(recipient.recipientPhone, recipient);
    }
  }

  if (recipientsByPhone.size > 0) {
    return [...recipientsByPhone.values()];
  }

  const owner = resolveOwnerNotificationRecipient(restaurant);
  return owner ? [owner] : [];
};
