import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "crypto";
import { handleWebsiteChatMessage } from "../services/websiteChat.service";

export const handleWebsiteChat = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.trustedBusiness) {
      res.status(401).json({ success: false, message: "Website integration is not authorized" });
      return;
    }

    const result = await handleWebsiteChatMessage({
      business: req.trustedBusiness,
      conversationId: req.body.conversationId,
      message: req.body.message,
      requestId: req.header("x-request-id")?.trim() || randomUUID()
    });

    res.status(result.success ? 200 : 503).json({
      success: result.success,
      message: result.message,
      data: result.data,
      responseId: result.responseId
    });
  } catch (error) {
    next(error);
  }
};
