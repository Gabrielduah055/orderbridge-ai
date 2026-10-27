import type { NextFunction, Request, Response } from "express";
import * as businessService from "../services/business.service";
import { NotFoundError } from "../utils/httpErrors";
import { recordAdminAuditAfterMutation } from "../services/adminAudit.service";

export const createBusiness = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const result = await businessService.createBusiness(req.body);
    await recordAdminAuditAfterMutation({
      actor: req.user!,
      action: "business.create",
      targetType: "business",
      targetId: String(result.business._id),
      changedFields: Object.keys(req.body ?? {}),
      metadata: {
        businessType: result.business.type,
        websiteEnabled: Boolean(result.business.websiteIntegration?.enabled)
      }
    });
    res.status(201).json({
      success: true,
      message: "Business created successfully",
      data: result.business,
      ...(result.generatedWebsiteIntegrationKey
        ? { websiteIntegrationKey: result.generatedWebsiteIntegrationKey }
        : {})
    });
  } catch (error) {
    next(error);
  }
};

export const listBusinesses = async (
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    res.status(200).json({
      success: true,
      data: await businessService.listBusinesses()
    });
  } catch (error) {
    next(error);
  }
};

export const getBusiness = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const business = await businessService.getBusinessById(String(req.params.businessId));
    if (!business) throw new NotFoundError("Business not found");
    res.status(200).json({ success: true, data: business });
  } catch (error) {
    next(error);
  }
};
