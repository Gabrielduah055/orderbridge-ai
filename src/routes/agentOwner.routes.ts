import { Router } from "express";
import { handleOwnerMessage } from "../controllers/agentOwner.controller";
import { agentOwnerMessageSchema, validateRequest } from "../middleware/validateRequest";

const router = Router();

router.post("/message", validateRequest(agentOwnerMessageSchema), handleOwnerMessage);

export default router;
