import { Types } from "mongoose";
import {
  CustomerProfile,
  type ICustomerProfile,
  type ICustomerProfileDocument,
  type MarketingPreferenceSource
} from "../models/customerProfile.model";
import { CustomerCampaignRecipient } from "../models/customerCampaignRecipient.model";
import { OutboundMessage } from "../models/outboundMessage.model";
import { BadRequestError } from "../utils/httpErrors";
import { normalizeGhanaPhone } from "../utils/phone.util";

export type CustomerMarketingPreferenceCommand = "opt_in" | "opt_out";

export interface CustomerMarketingPreferenceCommandResult {
  handled: boolean;
  command?: CustomerMarketingPreferenceCommand;
  message?: string;
  profile?: ICustomerProfileDocument;
}

const optOutCommands = new Set([
  "STOP",
  "UNSUBSCRIBE",
  "OPT OUT",
  "DO NOT SEND ME PROMOTIONS",
  "DON'T SEND ME PROMOTIONS"
]);

const optInCommands = new Set([
  "START",
  "SUBSCRIBE",
  "OPT IN",
  "SEND ME PROMOTIONS",
  "SEND ME PROMOTIONS AGAIN"
]);

const normalizePreferenceCommandText = (message: string): string =>
  message
    .trim()
    .replace(/[’‘]/g, "'")
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .toUpperCase();

const ensureScopedPreferenceIdentity = (
  restaurantId: string,
  customerPhone: string
): string => {
  if (!Types.ObjectId.isValid(restaurantId)) {
    throw new BadRequestError("Invalid restaurantId");
  }

  const normalizedPhone = normalizeGhanaPhone(customerPhone);

  if (!/^\+[1-9]\d{7,14}$/.test(normalizedPhone)) {
    throw new BadRequestError("Invalid customerPhone");
  }

  return normalizedPhone;
};

export const parseCustomerMarketingPreferenceCommand = (
  message: string
): CustomerMarketingPreferenceCommand | null => {
  const normalized = normalizePreferenceCommandText(message);

  if (optOutCommands.has(normalized)) {
    return "opt_out";
  }

  if (optInCommands.has(normalized)) {
    return "opt_in";
  }

  return null;
};

export const isCustomerEligibleForMarketing = (
  profile: Pick<ICustomerProfile, "marketingConsent" | "isOptedOut">
): boolean =>
  profile.marketingConsent === true && profile.isOptedOut !== true;

export const cancelQueuedCustomerMarketingMessages = async (
  restaurantId: string,
  customerPhone: string,
  now = new Date()
): Promise<void> => {
  const normalizedPhone = ensureScopedPreferenceIdentity(
    restaurantId,
    customerPhone
  );
  const reason = "Customer opted out before marketing delivery";

  await Promise.all([
    OutboundMessage.updateMany(
      {
        restaurantId,
        to: normalizedPhone,
        status: "pending",
        "metadata.kind": "customer_campaign",
        "metadata.customerPhone": normalizedPhone
      },
      {
        $set: {
          status: "cancelled",
          lastError: reason
        }
      }
    ),
    CustomerCampaignRecipient.updateMany(
      {
        restaurantId,
        customerPhone: normalizedPhone,
        status: "pending"
      },
      {
        $set: {
          status: "cancelled",
          attemptedAt: now,
          failureReason: reason
        }
      }
    )
  ]);
};

const cancelQueuedMarketingConsentRequest = async (
  restaurantId: string,
  customerPhone: string
): Promise<void> => {
  await OutboundMessage.updateMany(
    {
      restaurantId,
      to: customerPhone,
      status: "pending",
      "metadata.kind": "marketing_consent_request",
      "metadata.customerPhone": customerPhone
    },
    {
      $set: {
        status: "cancelled",
        lastError:
          "Customer preference was resolved before consent prompt delivery"
      }
    }
  );
};

export const setCustomerMarketingPreference = async (
  restaurantId: string,
  customerPhone: string,
  command: CustomerMarketingPreferenceCommand,
  source: MarketingPreferenceSource,
  now = new Date()
): Promise<ICustomerProfileDocument> => {
  const normalizedPhone = ensureScopedPreferenceIdentity(
    restaurantId,
    customerPhone
  );
  const existing = await CustomerProfile.findOne({
    restaurantId,
    customerPhone: normalizedPhone
  });
  const alreadyApplied =
    command === "opt_in"
      ? existing?.marketingConsent === true &&
        existing.isOptedOut !== true &&
        !existing.optedOutAt &&
        !existing.optedOutSource
      : existing?.isOptedOut === true &&
        existing.marketingConsent === false;

  if (alreadyApplied && existing) {
    if (command === "opt_out") {
      await cancelQueuedMarketingConsentRequest(
        restaurantId,
        normalizedPhone
      );
      await cancelQueuedCustomerMarketingMessages(
        restaurantId,
        normalizedPhone,
        now
      );
    }

    return existing;
  }

  const preferenceFields =
    command === "opt_in"
      ? {
          marketingConsent: true,
          marketingConsentAt: now,
          marketingConsentSource: source,
          isOptedOut: false,
          marketingPreferenceUpdatedAt: now
        }
      : {
          marketingConsent: false,
          isOptedOut: true,
          optedOutAt: now,
          optedOutSource: source,
          marketingPreferenceUpdatedAt: now
        };
  const profile = await CustomerProfile.findOneAndUpdate(
    {
      restaurantId,
      customerPhone: normalizedPhone
    },
    {
      $set: preferenceFields,
      ...(command === "opt_in"
        ? {
            $unset: {
              optedOutAt: "",
              optedOutSource: ""
            }
          }
        : {}),
      $setOnInsert: {
        restaurantId,
        customerPhone: normalizedPhone
      }
    },
    {
      new: true,
      upsert: true,
      runValidators: true,
      setDefaultsOnInsert: true
    }
  );

  if (!profile) {
    throw new Error("Customer marketing preference could not be updated");
  }

  if (command === "opt_out") {
    await cancelQueuedMarketingConsentRequest(
      restaurantId,
      normalizedPhone
    );
    await cancelQueuedCustomerMarketingMessages(
      restaurantId,
      normalizedPhone,
      now
    );
  }

  return profile;
};

export const getCustomerMarketingPreference = async (
  restaurantId: string,
  customerPhone: string
): Promise<{
  marketingConsent: boolean | null;
  isOptedOut: boolean;
  eligible: boolean;
  updatedAt?: Date;
}> => {
  const normalizedPhone = ensureScopedPreferenceIdentity(
    restaurantId,
    customerPhone
  );
  const profile = await CustomerProfile.findOne({
    restaurantId,
    customerPhone: normalizedPhone
  }).select(
    "marketingConsent isOptedOut marketingPreferenceUpdatedAt"
  );

  return {
    marketingConsent: profile?.marketingConsent ?? null,
    isOptedOut: profile?.isOptedOut === true,
    eligible: profile ? isCustomerEligibleForMarketing(profile) : false,
    updatedAt: profile?.marketingPreferenceUpdatedAt
  };
};

export const handleCustomerMarketingPreferenceCommand = async (
  restaurantId: string,
  customerPhone: string,
  message: string,
  now = new Date()
): Promise<CustomerMarketingPreferenceCommandResult> => {
  const command = parseCustomerMarketingPreferenceCommand(message);

  if (!command) {
    return {
      handled: false
    };
  }

  const profile = await setCustomerMarketingPreference(
    restaurantId,
    customerPhone,
    command,
    "customer_message",
    now
  );

  return {
    handled: true,
    command,
    profile,
    message:
      command === "opt_out"
        ? "You have been opted out of promotional messages from this restaurant. Transactional order updates and receipts will still be sent."
        : "You are subscribed to promotional messages from this restaurant. Reply STOP at any time to opt out."
  };
};
