import { Router } from "express";
import { handleWebsiteChat } from "../controllers/websiteChat.controller";
import { authenticateWebsiteChat } from "../middleware/websiteChatAuth.middleware";
import { enforceWebsiteChatRateLimit } from "../middleware/websiteChatRateLimit.middleware";
import { validateRequest, websiteChatMessageSchema } from "../middleware/validateRequest";

const router = Router();

router.post(
  "/:businessId/messages",
  validateRequest(websiteChatMessageSchema),
  authenticateWebsiteChat,
  enforceWebsiteChatRateLimit,
  handleWebsiteChat
);

export default router;
