import { Router } from "express";
import { handleCustomerMessage } from "../controllers/agentCustomer.controller";
import { agentCustomerMessageSchema, validateRequest } from "../middleware/validateRequest";

const router = Router();

router.post("/message", validateRequest(agentCustomerMessageSchema), handleCustomerMessage);

export default router;
