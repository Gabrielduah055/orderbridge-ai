import type { NextFunction, Request, Response } from "express";
import { receiveCommercePaidOrderEvent } from "../services/commercePaidOrderEvent.service";

export const receivePaidOrderEvent = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.trustedBusiness) {
      res.status(401).json({
        success: false,
        message: "Commerce integration is not authorized"
      });
      return;
    }

    const result = await receiveCommercePaidOrderEvent(
      String(req.trustedBusiness._id),
      req.body
    );

    if (result.outcome === "conflict") {
      res.status(409).json({
        success: false,
        message: "Commerce event identifiers conflict with a previously received event"
      });
      return;
    }

    res.status(result.outcome === "created" ? 201 : 200).json({
      success: true,
      message:
        result.outcome === "created"
          ? "Commerce event received"
          : "Commerce event already received",
      data: {
        eventId: result.eventId,
        status: "received"
      }
    });
  } catch (error) {
    next(error);
  }
};
