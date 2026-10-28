import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "crypto";
import { handleWebsiteChatMessage } from "../services/websiteChat.service";
import {
  createWebsiteConversationIdentity,
  verifyWebsiteConversationIdentity,
  type WebsiteConversationIdentity
} from "../services/websiteIntegrationAuth.service";

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

    const businessId = String(req.trustedBusiness._id);
    const integrationKeyHash =
      req.trustedBusiness.websiteIntegration?.integrationKeyHash;
    let conversation: WebsiteConversationIdentity;

    if (req.body.conversationId && req.body.conversationToken) {
      if (
        !verifyWebsiteConversationIdentity(
          businessId,
          req.body.conversationId,
          req.body.conversationToken,
          integrationKeyHash
        )
      ) {
        res.status(401).json({
          success: false,
          message: "Website conversation authorization is invalid"
        });
        return;
      }

      conversation = {
        conversationId: req.body.conversationId,
        conversationToken: req.body.conversationToken
      };
    } else {
      if (!integrationKeyHash) {
        res.status(401).json({
          success: false,
          message: "Website integration is not authorized"
        });
        return;
      }
      conversation = createWebsiteConversationIdentity(
        businessId,
        integrationKeyHash
      );
    }

    const result = await handleWebsiteChatMessage({
      business: req.trustedBusiness,
      conversationId: conversation.conversationId,
      message: req.body.message,
      requestId: req.header("x-request-id")?.trim() || randomUUID()
    });
    const responseData = result.data ? { ...result.data } : undefined;
    if (responseData) delete responseData.commerceGrounding;

    res.status(result.success ? 200 : 503).json({
      success: result.success,
      message: result.message,
      data: responseData,
      responseId: result.responseId,
      conversation
    });
  } catch (error) {
    next(error);
  }
};
