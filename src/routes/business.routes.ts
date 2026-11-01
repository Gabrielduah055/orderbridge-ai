import { Router } from "express";
import {
  createBusiness,
  getBusiness,
  listBusinesses,
  updateBusiness
} from "../controllers/business.controller";
import { firebaseAuth } from "../middleware/firebaseAuth.middleware";
import { requireSuperAdmin } from "../middleware/requireSuperAdmin";
import {
  createBusinessSchema,
  updateBusinessSchema,
  validateRequest
} from "../middleware/validateRequest";

const router = Router();
router.use(firebaseAuth, requireSuperAdmin);
router.post("/", validateRequest(createBusinessSchema), createBusiness);
router.get("/", listBusinesses);
router.get("/:businessId", getBusiness);
router.patch("/:businessId", validateRequest(updateBusinessSchema), updateBusiness);

export default router;
