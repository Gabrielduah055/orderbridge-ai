import { randomBytes } from "crypto";
import slugify from "slugify";
import { Business } from "../models/business.model";
import type { z } from "zod";
import type { createBusinessSchema } from "../middleware/validateRequest";
import { hashWebsiteIntegrationKey } from "./websiteIntegrationAuth.service";

export type CreateBusinessInput = z.infer<typeof createBusinessSchema>;

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
