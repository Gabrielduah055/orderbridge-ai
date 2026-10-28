import type { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { Business } from "../models/business.model";
import { verifyWebsiteIntegrationKey } from "../services/websiteIntegrationAuth.service";

const getIntegrationKey = (req: Request): string | undefined => {
  const authorization = req.header("authorization");

  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }

  return req.header("x-orderbridge-integration-key")?.trim();
};

export const authenticateWebsiteChat = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const businessId = String(req.params.businessId ?? "").trim();

    if (!Types.ObjectId.isValid(businessId)) {
      res.status(401).json({ success: false, message: "Invalid website integration credentials" });
      return;
    }

    const business = await Business.findOne({
      _id: businessId,
      type: "ecommerce",
      status: { $in: ["trial", "active"] },
      enabledChannels: "website",
      capabilities: { $all: ["website_chat", "commerce_catalog_read"] },
      "websiteIntegration.enabled": true
    }).select(
      "+websiteIntegration.integrationKeyHash +commerceIntegration.apiKey"
    );

    if (
      !business ||
      !verifyWebsiteIntegrationKey(
        getIntegrationKey(req),
        business.websiteIntegration?.integrationKeyHash
      )
    ) {
      res.status(401).json({ success: false, message: "Invalid website integration credentials" });
      return;
    }

    const origin = req.header("origin")?.trim();
    const allowedOrigins = business.websiteIntegration?.allowedOrigins ?? [];
    if (origin && allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) {
      res.status(403).json({ success: false, message: "Website origin is not authorized" });
      return;
    }

    req.trustedBusiness = business;
    next();
  } catch (error) {
    next(error);
  }
};
