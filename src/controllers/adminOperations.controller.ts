import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import {
  getAdminAuditLogs,
  getAgentOperations,
  getSystemHealth,
  getWhatsAppOperations,
  type OperationsWindow
} from "../services/adminOperations.service";
import { adminAuditActions } from "../services/adminAudit.service";

const objectIdSchema = z.string().trim().regex(/^[a-f\d]{24}$/i, "Must be a MongoDB object id");

const windowDurations = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000
} as const;

const operationsQuerySchema = z.object({
  window: z.enum(["1h", "24h", "7d", "30d"]).default("24h"),
  restaurantId: objectIdSchema.optional(),
  after: objectIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  after: objectIdSchema.optional(),
  action: z.enum(adminAuditActions).optional(),
  actorId: objectIdSchema.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional()
});

const getWindow = (name: keyof typeof windowDurations): OperationsWindow => {
  const to = new Date();
  return {
    from: new Date(to.getTime() - windowDurations[name]),
    to
  };
};

export const getWhatsAppOperationsController = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const query = operationsQuerySchema.parse(req.query);
    const data = await getWhatsAppOperations({
      window: getWindow(query.window),
      limit: query.limit,
      after: query.after
    });
    res.status(200).json({
      success: true,
      message: "WhatsApp operations fetched successfully",
      data
    });
  } catch (error) {
    next(error);
  }
};

export const getAgentOperationsController = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const query = operationsQuerySchema.parse(req.query);
    const data = await getAgentOperations({
      window: getWindow(query.window),
      restaurantId: query.restaurantId
    });
    res.status(200).json({
      success: true,
      message: "Agent operations fetched successfully",
      data
    });
  } catch (error) {
    next(error);
  }
};

export const getSystemHealthController = async (
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const data = await getSystemHealth();
    res.status(200).json({
      success: true,
      message: "System health fetched successfully",
      data
    });
  } catch (error) {
    next(error);
  }
};

export const getAdminAuditLogsController = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const query = auditQuerySchema.parse(req.query);
    const data = await getAdminAuditLogs(query);
    res.status(200).json({
      success: true,
      message: "Admin audit logs fetched successfully",
      data
    });
  } catch (error) {
    next(error);
  }
};
