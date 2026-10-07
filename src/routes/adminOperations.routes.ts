import { Router } from "express";
import {
  getAdminAuditLogsController,
  getAgentOperationsController,
  getSystemHealthController,
  getWhatsAppOperationsController
} from "../controllers/adminOperations.controller";
import { firebaseAuth } from "../middleware/firebaseAuth.middleware";
import { requireSuperAdmin } from "../middleware/requireSuperAdmin";

const router = Router();

router.use(firebaseAuth, requireSuperAdmin);
router.get("/operations/whatsapp", getWhatsAppOperationsController);
router.get("/operations/agents", getAgentOperationsController);
router.get("/operations/health", getSystemHealthController);
router.get("/audit-logs", getAdminAuditLogsController);

export default router;
