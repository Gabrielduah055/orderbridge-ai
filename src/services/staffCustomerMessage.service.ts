import { Types } from "mongoose";
import { z } from "zod";
import {
  CustomerProfile,
  type ICustomerProfileDocument
} from "../models/customerProfile.model";
import {
  Restaurant,
  type IRestaurantDocument
} from "../models/Restaurant";
import type { SenderRole } from "../types/agent.types";
import { BadRequestError } from "../utils/httpErrors";
import {
  isValidWhatsappRecipient,
  normalizeWhatsappRecipient
} from "../utils/phone.util";
import {
  normalizeCustomerKey,
  resolveCurrentWhatsappRecipientResult
} from "./customerIdentity.service";
import { maskCustomerPhone } from "./customerProfile.service";
import { resolveSenderIdentity } from "./senderIdentity.service";
import { enqueueWasenderMessage } from "./wasenderQueue.service";

const staffCustomerMessageTargetSchema = z
  .object({
    customerName: z.string().trim().min(1).max(160).optional(),
    customerPhoneEnding: z
      .string()
      .trim()
      .regex(/^\d{3,10}$/, "Provide 3 to 10 phone-ending digits.")
      .optional()
  })
  .strict()
  .refine(
    (args) => Boolean(args.customerName || args.customerPhoneEnding),
    { message: "Provide a customer name or phone ending." }
  );

export const sendCustomerMessageSchema = z
  .object({
    customerName: z.string().trim().min(1).max(160).optional(),
    customerPhoneEnding: z
      .string()
      .trim()
      .regex(/^\d{3,10}$/, "Provide 3 to 10 phone-ending digits.")
      .optional(),
    message: z.string().trim().min(1).max(500)
  })
  .strict()
  .refine(
    (args) => Boolean(args.customerName || args.customerPhoneEnding),
    { message: "Provide a customer name or phone ending." }
  );

type StaffCustomerMessageProfile = Pick<
  ICustomerProfileDocument,
  | "_id"
  | "customerKey"
  | "customerPhone"
  | "customerName"
  | "isOptedOut"
>;

type StaffCustomerMessageRestaurant = Pick<
  IRestaurantDocument,
  | "_id"
  | "name"
  | "ownerName"
  | "ownerPhone"
  | "managerPhones"
  | "managerContacts"
  | "status"
  | "wasenderSessionId"
  | "wasenderApiToken"
>;

interface CurrentStaffCustomerMessageContext {
  restaurant: StaffCustomerMessageRestaurant;
  phone: string;
  role: Extract<SenderRole, "owner" | "manager">;
}

export interface StaffCustomerMessageTarget {
  customerProfileId: string;
  customerKey?: string;
  customerPhone: string;
  recipient: string;
  name: string;
  maskedPhone: string;
}

export interface StaffCustomerMessageResult {
  customer: {
    name: string;
    maskedPhone: string;
  };
  status: "pending" | "sending" | "sent";
}

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeDisplayText = (value: string): string =>
  value.trim().replace(/\s+/g, " ");

const getCustomerDisplayName = (
  profile: Pick<StaffCustomerMessageProfile, "customerName" | "customerPhone">
): string => {
  const savedName = profile.customerName
    ? normalizeDisplayText(profile.customerName)
    : "";
  const maskedPhone = maskCustomerPhone(profile.customerPhone);
  return savedName || `Customer ending ${maskedPhone.slice(-4)}`;
};

const loadCurrentStaffContext = async (
  restaurantId: string,
  senderPhone: string
): Promise<CurrentStaffCustomerMessageContext> => {
  if (!Types.ObjectId.isValid(restaurantId)) {
    throw new BadRequestError(
      "The restaurant context is invalid.",
      "STAFF_DIRECT_MESSAGE_INVALID_RESTAURANT"
    );
  }

  const restaurant = (await Restaurant.findById(restaurantId).select(
    "+wasenderApiToken name ownerName ownerPhone managerPhones managerContacts status wasenderSessionId"
  )) as StaffCustomerMessageRestaurant | null;

  if (!restaurant || !["trial", "active"].includes(restaurant.status)) {
    throw new BadRequestError(
      "The restaurant is not currently available for customer messaging.",
      "STAFF_DIRECT_MESSAGE_RESTAURANT_UNAVAILABLE"
    );
  }

  const sender = resolveSenderIdentity(restaurant, senderPhone);
  if (
    !sender.verified ||
    (sender.role !== "owner" && sender.role !== "manager")
  ) {
    throw new BadRequestError(
      "Only a currently verified owner or manager can message a customer.",
      "STAFF_DIRECT_MESSAGE_FORBIDDEN"
    );
  }

  if (
    !restaurant.wasenderSessionId?.trim() ||
    !restaurant.wasenderApiToken?.trim()
  ) {
    throw new BadRequestError(
      "Customer messaging is not configured for this restaurant.",
      "STAFF_DIRECT_MESSAGE_NOT_CONFIGURED"
    );
  }

  return {
    restaurant,
    phone: sender.normalizedPhone,
    role: sender.role
  };
};

const ensureCustomerCanReceiveDirectMessage = (
  profile: Pick<StaffCustomerMessageProfile, "isOptedOut">
): void => {
  if (profile.isOptedOut === true) {
    throw new BadRequestError(
      "That customer has opted out of direct restaurant messages.",
      "STAFF_DIRECT_MESSAGE_CUSTOMER_OPTED_OUT"
    );
  }
};

const resolveProfileRecipient = async (
  restaurant: StaffCustomerMessageRestaurant,
  profile: StaffCustomerMessageProfile
): Promise<string> => {
  const resolution = await resolveCurrentWhatsappRecipientResult({
    restaurantId: String(restaurant._id),
    customerKey: profile.customerKey,
    fallbackAddress: profile.customerPhone,
    apiKey: restaurant.wasenderApiToken,
    verifyUsername: true
  });

  if (!resolution.resolved || !resolution.recipient) {
    throw new BadRequestError(
      resolution.temporary
        ? "The customer's current WhatsApp identity could not be verified right now. Please try again."
        : "That customer does not have a current valid WhatsApp identity.",
      resolution.temporary
        ? "STAFF_DIRECT_MESSAGE_RECIPIENT_VERIFICATION_FAILED"
        : "STAFF_DIRECT_MESSAGE_INVALID_RECIPIENT"
    );
  }

  return resolution.recipient;
};

export const resolveStaffCustomerMessageTarget = async (input: {
  restaurantId: string;
  senderPhone: string;
  customerName?: string;
  customerPhoneEnding?: string;
}): Promise<StaffCustomerMessageTarget> => {
  const parsed = staffCustomerMessageTargetSchema.parse({
    customerName: input.customerName,
    customerPhoneEnding: input.customerPhoneEnding
  });
  const staff = await loadCurrentStaffContext(
    input.restaurantId,
    input.senderPhone
  );
  const normalizedName = parsed.customerName
    ? normalizeDisplayText(parsed.customerName)
    : undefined;
  const profiles = (await CustomerProfile.find({
    restaurantId: input.restaurantId,
    ...(normalizedName
      ? {
          customerName: {
            $regex: `^${escapeRegExp(normalizedName).replace(/\s+/g, "\\s+")}$`,
            $options: "i"
          }
        }
      : {}),
    ...(parsed.customerPhoneEnding
      ? {
          customerPhone: {
            $regex: `${escapeRegExp(parsed.customerPhoneEnding)}$`
          }
        }
      : {})
  })
    .select(
      "_id customerKey customerPhone customerName isOptedOut"
    )
    .limit(4)) as StaffCustomerMessageProfile[];

  if (profiles.length === 0) {
    throw new BadRequestError(
      "No saved customer in this restaurant matched that name or phone ending.",
      "STAFF_DIRECT_MESSAGE_CUSTOMER_NOT_FOUND"
    );
  }

  if (profiles.length > 1) {
    const candidates = profiles
      .slice(0, 3)
      .map(
        (profile) =>
          `${getCustomerDisplayName(profile)} (${maskCustomerPhone(profile.customerPhone)})`
      )
      .join(", ");
    throw new BadRequestError(
      `More than one saved customer matched. Please clarify with a phone ending: ${candidates}.`,
      "STAFF_DIRECT_MESSAGE_CUSTOMER_AMBIGUOUS"
    );
  }

  const profile = profiles[0];
  ensureCustomerCanReceiveDirectMessage(profile);
  const recipient = await resolveProfileRecipient(staff.restaurant, profile);
  const customerPhone = normalizeWhatsappRecipient(profile.customerPhone);

  if (!isValidWhatsappRecipient(customerPhone)) {
    throw new BadRequestError(
      "That customer does not have a valid saved WhatsApp identity.",
      "STAFF_DIRECT_MESSAGE_INVALID_RECIPIENT"
    );
  }

  return {
    customerProfileId: String(profile._id),
    ...(profile.customerKey
      ? {
          customerKey: normalizeCustomerKey(
            profile.customerKey,
            customerPhone
          )
        }
      : {}),
    customerPhone,
    recipient,
    name: getCustomerDisplayName(profile),
    maskedPhone: maskCustomerPhone(customerPhone)
  };
};

export const enqueueStaffCustomerMessage = async (input: {
  restaurantId: string;
  senderPhone: string;
  message: string;
  pendingActionId: string;
  customerProfileId: string;
  expectedCustomerKey?: string;
  expectedCustomerPhone: string;
}): Promise<StaffCustomerMessageResult> => {
  const message = z.string().trim().min(1).max(500).parse(input.message);
  if (
    !Types.ObjectId.isValid(input.pendingActionId) ||
    !Types.ObjectId.isValid(input.customerProfileId)
  ) {
    throw new BadRequestError(
      "The confirmed customer message is invalid. Please create a new preview.",
      "STAFF_DIRECT_MESSAGE_CONFIRMATION_INVALID"
    );
  }

  const staff = await loadCurrentStaffContext(
    input.restaurantId,
    input.senderPhone
  );
  const profile = (await CustomerProfile.findOne({
    _id: input.customerProfileId,
    restaurantId: input.restaurantId
  }).select(
    "_id customerKey customerPhone customerName isOptedOut"
  )) as StaffCustomerMessageProfile | null;

  if (!profile) {
    throw new BadRequestError(
      "That saved customer is no longer available. Please create a new preview.",
      "STAFF_DIRECT_MESSAGE_CUSTOMER_STALE"
    );
  }

  ensureCustomerCanReceiveDirectMessage(profile);
  const currentPhone = normalizeWhatsappRecipient(profile.customerPhone);
  const expectedPhone = normalizeWhatsappRecipient(
    input.expectedCustomerPhone
  );
  const currentKey = normalizeCustomerKey(
    profile.customerKey,
    currentPhone
  );
  const expectedKey = input.expectedCustomerKey
    ? normalizeCustomerKey(input.expectedCustomerKey, expectedPhone)
    : "";

  if (
    (expectedKey && currentKey !== expectedKey) ||
    (!expectedKey && currentPhone !== expectedPhone)
  ) {
    throw new BadRequestError(
      "The customer's WhatsApp identity changed after the preview. Please create a new preview.",
      "STAFF_DIRECT_MESSAGE_CUSTOMER_STALE"
    );
  }

  const recipient = await resolveProfileRecipient(staff.restaurant, profile);
  const queued = await enqueueWasenderMessage({
    restaurantId: input.restaurantId,
    sessionId: staff.restaurant.wasenderSessionId,
    to: recipient,
    type: "text",
    text: message,
    apiKey: staff.restaurant.wasenderApiToken,
    idempotencyKey: `staff-direct-message:${input.restaurantId}:${input.pendingActionId}`,
    metadata: {
      kind: "staff_direct_message",
      purpose: "staff_direct_message",
      restaurantId: input.restaurantId,
      customerProfileId: String(profile._id),
      ...(currentKey ? { customerKey: currentKey } : {}),
      customerPhone: currentPhone,
      recipientType: "customer",
      createdByPhone: staff.phone,
      createdByRole: staff.role,
      pendingActionId: input.pendingActionId
    }
  });

  if (
    queued.status !== "pending" &&
    queued.status !== "sending" &&
    queued.status !== "sent"
  ) {
    throw new BadRequestError(
      "That customer message could not be queued. Please create a new preview.",
      "STAFF_DIRECT_MESSAGE_QUEUE_FAILED"
    );
  }

  return {
    customer: {
      name: getCustomerDisplayName(profile),
      maskedPhone: maskCustomerPhone(currentPhone)
    },
    status: queued.status
  };
};
