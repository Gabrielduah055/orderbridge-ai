import { Types } from "mongoose";
import { CustomerProfile } from "../models/customerProfile.model";
import { Restaurant, type IRestaurantDocument } from "../models/Restaurant";
import { ForbiddenError, NotFoundError } from "../utils/httpErrors";
import { normalizeGhanaPhone } from "../utils/phone.util";
import { resolveSenderIdentity } from "./senderIdentity.service";
import {
  buildMarketingConsentRequestMessage,
  queueMarketingConsentRequest
} from "./customerMarketingOnboarding.service";

export interface MarketingConsentOutreachCounts {
  totalCustomers: number;
  eligible: number;
  excludedAlreadyOptedIn: number;
  excludedOptedOut: number;
  excludedAlreadyAsked: number;
  excludedInvalidPhone: number;
}

export interface MarketingConsentOutreachPreview
  extends MarketingConsentOutreachCounts {
  message: string;
}

export interface MarketingConsentOutreachResult
  extends MarketingConsentOutreachCounts {
  queued: number;
  failedToQueue: number;
}

interface OutreachAudience extends MarketingConsentOutreachPreview {
  eligiblePhones: string[];
  restaurant: IRestaurantDocument;
  requestedByPhone: string;
}

interface MarketingConsentOutreachDependencies {
  findRestaurant?: (restaurantId: string) => Promise<IRestaurantDocument | null>;
  findProfiles?: (restaurantId: string) => Promise<Array<{
    customerPhone: string;
    marketingConsent?: boolean | null;
    isOptedOut?: boolean;
    marketingConsentPromptedAt?: Date;
  }>>;
  queueRequest?: typeof queueMarketingConsentRequest;
}

const isValidCustomerPhone = (phone: string): boolean =>
  /^\+[1-9]\d{7,14}$/.test(phone);

const loadOutreachAudience = async (
  restaurantId: string,
  senderPhone: string,
  dependencies: MarketingConsentOutreachDependencies = {}
): Promise<OutreachAudience> => {
  if (!Types.ObjectId.isValid(restaurantId)) {
    throw new NotFoundError("Restaurant not found");
  }

  const restaurant = dependencies.findRestaurant
    ? await dependencies.findRestaurant(restaurantId)
    : await Restaurant.findOne({ _id: restaurantId }).select(
        "name ownerName ownerPhone managerPhones managerContacts status wasenderSessionId +wasenderApiToken"
      );

  if (!restaurant) {
    throw new NotFoundError("Restaurant not found");
  }

  if (restaurant.status !== "active" && restaurant.status !== "trial") {
    throw new ForbiddenError(
      "Marketing consent outreach is unavailable for this restaurant"
    );
  }

  const sender = resolveSenderIdentity(restaurant, senderPhone);

  if (
    !sender.verified ||
    (sender.role !== "owner" && sender.role !== "manager")
  ) {
    throw new ForbiddenError(
      "Only a verified owner or manager can invite customers to marketing"
    );
  }

  const profiles = dependencies.findProfiles
    ? await dependencies.findProfiles(restaurantId)
    : await CustomerProfile.find({ restaurantId }).select(
        "customerPhone marketingConsent isOptedOut marketingConsentPromptedAt"
      );
  const eligiblePhones: string[] = [];
  let excludedAlreadyOptedIn = 0;
  let excludedOptedOut = 0;
  let excludedAlreadyAsked = 0;
  let excludedInvalidPhone = 0;

  for (const profile of profiles) {
    if (profile.marketingConsent === true && profile.isOptedOut !== true) {
      excludedAlreadyOptedIn += 1;
      continue;
    }

    if (profile.isOptedOut === true || profile.marketingConsent === false) {
      excludedOptedOut += 1;
      continue;
    }

    if (profile.marketingConsentPromptedAt) {
      excludedAlreadyAsked += 1;
      continue;
    }

    const normalizedPhone = normalizeGhanaPhone(profile.customerPhone);

    if (!isValidCustomerPhone(normalizedPhone)) {
      excludedInvalidPhone += 1;
      continue;
    }

    eligiblePhones.push(normalizedPhone);
  }

  return {
    restaurant,
    requestedByPhone: sender.normalizedPhone,
    eligiblePhones,
    totalCustomers: profiles.length,
    eligible: eligiblePhones.length,
    excludedAlreadyOptedIn,
    excludedOptedOut,
    excludedAlreadyAsked,
    excludedInvalidPhone,
    message: buildMarketingConsentRequestMessage(restaurant.name)
  };
};

const toPublicPreview = (
  audience: OutreachAudience
): MarketingConsentOutreachPreview => ({
  totalCustomers: audience.totalCustomers,
  eligible: audience.eligible,
  excludedAlreadyOptedIn: audience.excludedAlreadyOptedIn,
  excludedOptedOut: audience.excludedOptedOut,
  excludedAlreadyAsked: audience.excludedAlreadyAsked,
  excludedInvalidPhone: audience.excludedInvalidPhone,
  message: audience.message
});

export const previewMarketingConsentOutreach = async (
  restaurantId: string,
  senderPhone: string,
  dependencies: MarketingConsentOutreachDependencies = {}
): Promise<MarketingConsentOutreachPreview> =>
  toPublicPreview(
    await loadOutreachAudience(restaurantId, senderPhone, dependencies)
  );

export const buildMarketingConsentOutreachPreviewMessage = (
  preview: MarketingConsentOutreachPreview
): string => {
  if (preview.eligible === 0) {
    return "All customers have already either chosen a preference, have already been asked, or do not have a valid phone number.";
  }

  return [
    "I can send a one-time promotion preference request.",
    "Customer Summary:",
    `Total customers: ${preview.totalCustomers}`,
    `Already receiving promotions: ${preview.excludedAlreadyOptedIn}`,
    `Opted out: ${preview.excludedOptedOut}`,
    `Already asked: ${preview.excludedAlreadyAsked}`,
    ...(preview.excludedInvalidPhone > 0
      ? [`Invalid phone numbers: ${preview.excludedInvalidPhone}`]
      : []),
    `Eligible to ask now: ${preview.eligible}`,
    "Message:",
    `'${preview.message}'`,
    `Send this to ${preview.eligible} customer${preview.eligible === 1 ? "" : "s"}?`
  ].join("\n\n");
};

export const executeMarketingConsentOutreach = async (
  restaurantId: string,
  senderPhone: string,
  dependencies: MarketingConsentOutreachDependencies = {}
): Promise<MarketingConsentOutreachResult> => {
  const audience = await loadOutreachAudience(
    restaurantId,
    senderPhone,
    dependencies
  );
  const queueRequest = dependencies.queueRequest ?? queueMarketingConsentRequest;
  let queued = 0;
  let failedToQueue = 0;

  for (const customerPhone of audience.eligiblePhones) {
    try {
      const result = await queueRequest(
        {
          restaurantId,
          customerPhone,
          source: "staff_outreach",
          requestedByPhone: audience.requestedByPhone
        },
        {
          findRestaurant: async () => audience.restaurant
        }
      );

      if (result.queued) {
        queued += 1;
      } else {
        failedToQueue += 1;
      }
    } catch (error) {
      failedToQueue += 1;
      console.error("Marketing consent outreach queue failed", {
        restaurantId,
        errorType: error instanceof Error ? error.name : "UnknownError"
      });
    }
  }

  return {
    totalCustomers: audience.totalCustomers,
    eligible: audience.eligible,
    excludedAlreadyOptedIn: audience.excludedAlreadyOptedIn,
    excludedOptedOut: audience.excludedOptedOut,
    excludedAlreadyAsked: audience.excludedAlreadyAsked,
    excludedInvalidPhone: audience.excludedInvalidPhone,
    queued,
    failedToQueue
  };
};
