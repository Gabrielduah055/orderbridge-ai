import { Router } from "express";
import {
  createBusiness,
  getBusiness,
  listBusinesses,
  rotateWebsiteIntegrationKey,
  testCommerceConnection,
  updateBusiness
} from "../controllers/business.controller";
import { firebaseAuth } from "../middleware/firebaseAuth.middleware";
import { requireSuperAdmin } from "../middleware/requireSuperAdmin";
import {
  createBusinessSchema,
  testCommerceConnectionSchema,
  updateBusinessSchema,
  validateRequest
} from "../middleware/validateRequest";

const router = Router();
router.use(firebaseAuth, requireSuperAdmin);
router.post("/", validateRequest(createBusinessSchema), createBusiness);
router.get("/", listBusinesses);
router.post("/:businessId/website/rotate-key", rotateWebsiteIntegrationKey);
router.post(
  "/:businessId/commerce/test",
  validateRequest(testCommerceConnectionSchema),
  testCommerceConnection
);
router.get("/:businessId", getBusiness);
router.patch("/:businessId", validateRequest(updateBusinessSchema), updateBusiness);

export default router;
