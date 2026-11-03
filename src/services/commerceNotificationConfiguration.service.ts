import type { IBusinessDocument } from "../models/business.model";
import {
  isWhatsappPhoneAddress,
  normalizeGhanaPhone
} from "../utils/phone.util";

export const commercePaidOrderCustomerNotificationKind =
  "commerce_paid_order_customer";
export const commercePaidOrderStaffNotificationKind =
  "commerce_paid_order_staff";
export const commercePaidOrderReceiptNotificationKind =
  "commerce_paid_order_receipt";

export const isCommercePaidOrderNotificationKind = (
  kind: unknown
): boolean =>
  kind === commercePaidOrderCustomerNotificationKind ||
  kind === commercePaidOrderStaffNotificationKind ||
  kind === commercePaidOrderReceiptNotificationKind;

export const getNormalizedCommerceStaffRecipients = (
  business: Pick<IBusinessDocument, "ownerPhone" | "staff">
): string[] => {
  const recipients = [
    business.ownerPhone,
    ...business.staff.map((contact) => contact.phone)
  ];

  return Array.from(
    new Set(
      recipients
        .map((phone) => (phone ? normalizeGhanaPhone(phone) : ""))
        .filter((phone) => isWhatsappPhoneAddress(phone))
    )
  );
};

export const getCommerceNotificationConfigurationReason = (
  business: IBusinessDocument
): string | null => {
  if (business.type !== "ecommerce") return "business_is_not_ecommerce";
  if (business.status !== "active" && business.status !== "trial") {
    return "business_inactive";
  }

  const integration = business.whatsappIntegration;
  if (!integration?.commerceNotificationsEnabled) {
    return "commerce_notifications_paused";
  }
  if (!integration.enabled) return "business_whatsapp_disabled";
  if (!business.enabledChannels.includes("whatsapp")) {
    return "business_whatsapp_channel_disabled";
  }
  if (!integration.wasenderSessionId?.trim()) {
    return "business_wasender_session_missing";
  }
  if (!integration.wasenderApiToken?.trim()) {
    return "business_wasender_token_missing";
  }
  if (!isWhatsappPhoneAddress(integration.whatsappNumber)) {
    return "business_whatsapp_number_invalid";
  }
  if (getNormalizedCommerceStaffRecipients(business).length === 0) {
    return "business_notification_recipients_missing";
  }

  return null;
};
