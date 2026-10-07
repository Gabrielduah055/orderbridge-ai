import type { NextFunction, Request, Response } from "express";
import * as menuImportService from "../services/menuImport.service";
import type { MenuImportMode } from "../types/menu.types";
import { recordAdminAuditAfterMutation } from "../services/adminAudit.service";

const getRestaurantId = (req: Request): string => {
  return String(req.params.restaurantId);
};

export const importMenuFile = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const importRecord = await menuImportService.importMenuFile(
      getRestaurantId(req),
      req.file,
      req.body.importMode as MenuImportMode | undefined
    );

    await recordAdminAuditAfterMutation({
      actor: req.user!,
      action: "menu.import",
      targetType: "menu_import",
      targetId: String(importRecord._id),
      restaurantId: String(importRecord.restaurantId),
      changedFields: ["fileType", "importMode", "status"],
      metadata: {
        fileType: importRecord.fileType,
        importMode: req.body.importMode
      }
    });

    res.status(201).json({
      success: true,
      message: "Menu file uploaded successfully. AI extraction will be added later.",
      fileType: importRecord.fileType,
      fileUrl: importRecord.fileUrl,
      status: importRecord.status,
      data: importRecord
    });
  } catch (error) {
    next(error);
  }
};
