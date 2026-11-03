import { randomBytes } from "crypto";
import { Types } from "mongoose";
import slugify from "slugify";
import { Business, type IBusinessDocument } from "../models/business.model";
import type { z } from "zod";
import type {
  createBusinessSchema,
  updateBusinessSchema
} from "../middleware/validateRequest";
import { hashWebsiteIntegrationKey } from "./websiteIntegrationAuth.service";
import { BadRequestError, ConflictError } from "../utils/httpErrors";
import { isWhatsappPhoneAddress } from "../utils/phone.util";

export type CreateBusinessInput = z.infer<typeof createBusinessSchema>;
export type UpdateBusinessInput = z.infer<typeof updateBusinessSchema>;

type DuplicateKeyError = {
  code?: number;
  keyPattern?: Record<string, unknown>;
};

const throwSafeBusinessConflict = (error: unknown): never => {
  const duplicateError = error as DuplicateKeyError;
  if (duplicateError?.code !== 11000) throw error;

  if (duplicateError.keyPattern?.["whatsappIntegration.wasenderSessionId"]) {
    throw new ConflictError("That Wasender session is already assigned to another business");
  }
  if (duplicateError.keyPattern?.["whatsappIntegration.whatsappNumber"]) {
    throw new ConflictError("That WhatsApp number is already assigned to another business");
  }
  throw new ConflictError("A business with the same unique configuration already exists");
};

const validateEnabledWhatsappConfiguration = (
  business: IBusinessDocument
): void => {
  const integration = business.whatsappIntegration;
  if (!integration?.enabled) return;

  if (!integration.wasenderSessionId?.trim()) {
    throw new BadRequestError("A Wasender session ID is required to enable WhatsApp");
  }
  if (!integration.wasenderApiToken?.trim()) {
    throw new BadRequestError("A Wasender API token is required to enable WhatsApp");
  }
  if (!isWhatsappPhoneAddress(integration.whatsappNumber)) {
    throw new BadRequestError("A valid WhatsApp sending number is required to enable WhatsApp");
  }

  const notificationPhones = [
    business.ownerPhone,
    ...business.staff.map((contact) => contact.phone)
  ];
  if (!notificationPhones.some((phone) => isWhatsappPhoneAddress(phone))) {
    throw new BadRequestError(
      "At least one valid owner or manager notification number is required to enable WhatsApp"
    );
  }
};

export const createBusiness = async (input: CreateBusinessInput) => {
  const generatedIntegrationKey =
    input.websiteIntegration?.enabled && !input.websiteIntegration.integrationKey
      ? randomBytes(32).toString("base64url")
      : undefined;
  const integrationKey =
    input.websiteIntegration?.integrationKey ?? generatedIntegrationKey;

  let business: IBusinessDocument;
  try {
    business = new Business({
      ...input,
      slug: input.slug ?? slugify(input.name, { lower: true, strict: true }),
      websiteIntegration: input.websiteIntegration
        ? {
            enabled: input.websiteIntegration.enabled,
            allowedOrigins: input.websiteIntegration.allowedOrigins,
            requestsPerMinute: input.websiteIntegration.requestsPerMinute,
            ...(integrationKey
              ? { integrationKeyHash: hashWebsiteIntegrationKey(integrationKey) }
              : {})
          }
        : undefined
    });
    const enabledChannels = business.enabledChannels.filter(
      (channel) => channel !== "whatsapp"
    );
    if (business.whatsappIntegration?.enabled) enabledChannels.push("whatsapp");
    business.enabledChannels = enabledChannels;
    validateEnabledWhatsappConfiguration(business);
    await business.save();
  } catch (error) {
    return throwSafeBusinessConflict(error);
  }

  return {
    business,
    generatedWebsiteIntegrationKey: generatedIntegrationKey
  };
};

export const listBusinesses = async () =>
  Business.find({})
    .select("+whatsappIntegration.wasenderApiToken")
    .sort({ createdAt: -1 });

export const getBusinessById = async (businessId: string) =>
  Business.findById(businessId).select("+whatsappIntegration.wasenderApiToken");

export const getBusinessForCommerceConnectionCheck = async (businessId: string) => {
  if (!Types.ObjectId.isValid(businessId)) return null;

  return Business.findById(businessId).select("+commerceIntegration.apiKey");
};

export const rotateWebsiteIntegrationKey = async (businessId: string) => {
  if (!Types.ObjectId.isValid(businessId)) return null;

  const websiteIntegrationKey = randomBytes(32).toString("base64url");
  const integrationKeyHash = hashWebsiteIntegrationKey(websiteIntegrationKey);
  const business = await Business.findOneAndUpdate(
    { _id: businessId },
    { $set: { "websiteIntegration.integrationKeyHash": integrationKeyHash } },
    { new: true }
  );

  if (!business) return null;

  return {
    business,
    websiteIntegrationKey
  };
};

export const updateBusiness = async (
  businessId: string,
  input: UpdateBusinessInput
) => {
  if (!Types.ObjectId.isValid(businessId)) return null;

  const business = await Business.findById(businessId).select(
    "+whatsappIntegration.wasenderApiToken"
  );
  if (!business) return null;

  const changedFields: string[] = [];
  const setField = (path: string, value: unknown): void => {
    if (value === undefined) return;
    business.set(path, value);
    changedFields.push(path);
  };

  setField("name", input.name);
  setField("status", input.status);
  setField("ownerName", input.ownerName);
  setField("ownerEmail", input.ownerEmail);
  setField("ownerPhone", input.ownerPhone);
  setField("staff", input.staff);
  setField("timezone", input.timezone);
  setField("agentInstructions", input.agentInstructions);

  setField("websiteIntegration.enabled", input.websiteIntegration?.enabled);
  setField(
    "websiteIntegration.allowedOrigins",
    input.websiteIntegration?.allowedOrigins
  );
  setField(
    "websiteIntegration.requestsPerMinute",
    input.websiteIntegration?.requestsPerMinute
  );

  setField("whatsappIntegration.enabled", input.whatsappIntegration?.enabled);
  setField(
    "whatsappIntegration.commerceNotificationsEnabled",
    input.whatsappIntegration?.commerceNotificationsEnabled
  );
  setField(
    "whatsappIntegration.wasenderSessionId",
    input.whatsappIntegration?.wasenderSessionId
  );
  setField(
    "whatsappIntegration.whatsappNumber",
    input.whatsappIntegration?.whatsappNumber
  );
  const wasenderApiToken = input.whatsappIntegration?.wasenderApiToken;
  if (wasenderApiToken) {
    setField("whatsappIntegration.wasenderApiToken", wasenderApiToken);
  }

  setField("commerceIntegration.baseUrl", input.commerceIntegration?.baseUrl);
  setField("commerceIntegration.authType", input.commerceIntegration?.authType);
  setField(
    "commerceIntegration.apiKeyHeader",
    input.commerceIntegration?.apiKeyHeader
  );
  setField(
    "commerceIntegration.paths.search",
    input.commerceIntegration?.paths?.search
  );
  setField(
    "commerceIntegration.paths.product",
    input.commerceIntegration?.paths?.product
  );
  setField(
    "commerceIntegration.paths.availability",
    input.commerceIntegration?.paths?.availability
  );
  setField(
    "commerceIntegration.paths.policies",
    input.commerceIntegration?.paths?.policies
  );
  setField(
    "commerceIntegration.canonicalProductHosts",
    input.commerceIntegration?.canonicalProductHosts
  );

  const apiKey = input.commerceIntegration?.apiKey;
  if (apiKey) {
    setField("commerceIntegration.apiKey", apiKey);
  }

  if (input.whatsappIntegration !== undefined) {
    const enabledChannels = business.enabledChannels.filter(
      (channel) => channel !== "whatsapp"
    );
    if (business.whatsappIntegration?.enabled) enabledChannels.push("whatsapp");
    if (enabledChannels.join("|") !== business.enabledChannels.join("|")) {
      setField("enabledChannels", enabledChannels);
    }
  }

  if (
    business.whatsappIntegration?.enabled &&
    (input.whatsappIntegration !== undefined ||
      input.ownerPhone !== undefined ||
      input.staff !== undefined)
  ) {
    validateEnabledWhatsappConfiguration(business);
  }

  if (changedFields.length > 0) {
    try {
      await business.save();
    } catch (error) {
      throwSafeBusinessConflict(error);
    }
  }

  return { business, changedFields };
};
