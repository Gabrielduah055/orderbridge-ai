import { randomBytes } from "crypto";
import { Types } from "mongoose";
import slugify from "slugify";
import { Business } from "../models/business.model";
import type { z } from "zod";
import type {
  createBusinessSchema,
  updateBusinessSchema
} from "../middleware/validateRequest";
import { hashWebsiteIntegrationKey } from "./websiteIntegrationAuth.service";

export type CreateBusinessInput = z.infer<typeof createBusinessSchema>;
export type UpdateBusinessInput = z.infer<typeof updateBusinessSchema>;

export const createBusiness = async (input: CreateBusinessInput) => {
  const generatedIntegrationKey =
    input.websiteIntegration?.enabled && !input.websiteIntegration.integrationKey
      ? randomBytes(32).toString("base64url")
      : undefined;
  const integrationKey =
    input.websiteIntegration?.integrationKey ?? generatedIntegrationKey;

  const business = await Business.create({
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

  return {
    business,
    generatedWebsiteIntegrationKey: generatedIntegrationKey
  };
};

export const listBusinesses = async () =>
  Business.find({}).sort({ createdAt: -1 });

export const getBusinessById = async (businessId: string) =>
  Business.findById(businessId);

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

  const business = await Business.findById(businessId);
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

  if (changedFields.length > 0) {
    await business.save();
  }

  return { business, changedFields };
};
