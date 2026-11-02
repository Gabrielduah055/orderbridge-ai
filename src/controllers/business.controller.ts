import type { NextFunction, Request, Response } from "express";
import * as businessService from "../services/business.service";
import { NotFoundError } from "../utils/httpErrors";
import { recordAdminAuditAfterMutation } from "../services/adminAudit.service";
import { testCommerceConnection as runCommerceConnectionTest } from "../services/commerceIntegration.service";

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

export const updateBusiness = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const result = await businessService.updateBusiness(
      String(req.params.businessId),
      req.body
    );
    if (!result) throw new NotFoundError("Business not found");

    await recordAdminAuditAfterMutation({
      actor: req.user!,
      action: "business.update",
      targetType: "business",
      targetId: String(result.business._id),
      changedFields: result.changedFields,
      metadata: { status: result.business.status }
    });

    res.status(200).json({
      success: true,
      message: "Business updated successfully",
      data: result.business
    });
  } catch (error) {
    next(error);
  }
};

export const testCommerceConnection = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const business = await businessService.getBusinessForCommerceConnectionCheck(
      String(req.params.businessId)
    );
    if (!business) throw new NotFoundError("Business not found");

    const result = await runCommerceConnectionTest(business, req.body.searchTerm);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const rotateWebsiteIntegrationKey = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const result = await businessService.rotateWebsiteIntegrationKey(
      String(req.params.businessId)
    );
    if (!result) throw new NotFoundError("Business not found");

    await recordAdminAuditAfterMutation({
      actor: req.user!,
      action: "business.website_key.rotate",
      targetType: "business",
      targetId: String(result.business._id),
      changedFields: ["websiteIntegration"]
    });

    res.status(200).json({
      success: true,
      message: "Website integration key regenerated successfully",
      data: { websiteIntegrationKey: result.websiteIntegrationKey }
    });
  } catch (error) {
    next(error);
  }
};
