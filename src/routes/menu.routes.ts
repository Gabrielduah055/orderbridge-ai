import { Router } from "express";
import {
  deactivateCategory,
  updateCategory
} from "../controllers/menuCategory.controller";
import {
  deactivateMenuItem,
  getMenuItemsByCategory,
  updateMenuItem,
  updateMenuItemAvailability,
  uploadMenuItemImage
} from "../controllers/menuItem.controller";
import { firebaseAuth } from "../middleware/firebaseAuth.middleware";
import { requireSuperAdmin } from "../middleware/requireSuperAdmin";
import { uploadMenuItemImage as uploadMenuItemImageMiddleware } from "../middleware/upload.middleware";
import {
  updateMenuCategorySchema,
  updateMenuItemAvailabilitySchema,
  updateMenuItemSchema,
  validateRequest
} from "../middleware/validateRequest";

const router = Router();

router.use(firebaseAuth, requireSuperAdmin);

router.get("/categories/:categoryId/items", getMenuItemsByCategory);
router.patch(
  "/categories/:categoryId",
  validateRequest(updateMenuCategorySchema),
  updateCategory
);
router.delete("/categories/:categoryId", deactivateCategory);
router.patch("/items/:itemId", validateRequest(updateMenuItemSchema), updateMenuItem);
router.delete("/items/:itemId", deactivateMenuItem);
router.patch(
  "/items/:itemId/availability",
  validateRequest(updateMenuItemAvailabilitySchema),
  updateMenuItemAvailability
);
router.post("/items/:itemId/image", uploadMenuItemImageMiddleware, uploadMenuItemImage);

export default router;
