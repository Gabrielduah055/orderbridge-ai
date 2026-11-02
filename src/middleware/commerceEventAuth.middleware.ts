import type { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { Business } from "../models/business.model";
import { verifyWebsiteIntegrationKey } from "../services/websiteIntegrationAuth.service";

const getBearerIntegrationKey = (req: Request): string | undefined => {
  const match = req.header("authorization")?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1];
};

export const authenticateCommerceEvent = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const businessId = String(req.params.businessId ?? "").trim();

    if (!Types.ObjectId.isValid(businessId)) {
      res.status(401).json({
        success: false,
        message: "Invalid commerce integration credentials"
      });
      return;
    }

    const business = await Business.findOne({
      _id: businessId,
      type: "ecommerce",
      status: { $in: ["trial", "active"] }
    }).select("+websiteIntegration.integrationKeyHash");

    if (
      !business ||
      !verifyWebsiteIntegrationKey(
        getBearerIntegrationKey(req),
        business.websiteIntegration?.integrationKeyHash
      )
    ) {
      res.status(401).json({
        success: false,
        message: "Invalid commerce integration credentials"
      });
      return;
    }

    req.trustedBusiness = business;
    next();
  } catch (error) {
    next(error);
  }
};
