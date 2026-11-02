import { Router } from "express";
import { receivePaidOrderEvent } from "../controllers/commerceEvent.controller";
import { authenticateCommerceEvent } from "../middleware/commerceEventAuth.middleware";
import {
  commercePaidOrderEventSchema,
  validateRequest
} from "../middleware/validateRequest";

const router = Router();

router.post(
  "/:businessId/events",
  authenticateCommerceEvent,
  validateRequest(commercePaidOrderEventSchema),
  receivePaidOrderEvent
);

export default router;
