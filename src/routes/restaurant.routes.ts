import { Router } from "express";
import {
  createRestaurant,
  deleteRestaurant,
  getRestaurantById,
  getRestaurants,
  markSubscriptionPaid,
  updateRestaurant,
  updateRestaurantPlan,
  updateRestaurantStatus
} from "../controllers/restaurant.controller";
import {
  createCategory,
  getCategoriesByRestaurant,
  reorderCategories
} from "../controllers/menuCategory.controller";
import {
  addMenuItem,
  getMenuItemsByRestaurant
} from "../controllers/menuItem.controller";
import { importMenuFile } from "../controllers/menuImport.controller";
import { firebaseAuth } from "../middleware/firebaseAuth.middleware";
import { requireSuperAdmin } from "../middleware/requireSuperAdmin";
import { uploadMenuImportFile } from "../middleware/upload.middleware";
import {
  createMenuCategorySchema,
  createMenuItemSchema,
  createRestaurantSchema,
  markSubscriptionPaidSchema,
  reorderMenuCategoriesSchema,
  updateRestaurantPlanSchema,
  updateRestaurantSchema,
  updateRestaurantStatusSchema,
  validateRequest
} from "../middleware/validateRequest";

const router = Router();

router.use(firebaseAuth, requireSuperAdmin);

router.post("/", validateRequest(createRestaurantSchema), createRestaurant);
router.get("/", getRestaurants);
router.post(
  "/:restaurantId/menu/categories",
  validateRequest(createMenuCategorySchema),
  createCategory
);
router.get("/:restaurantId/menu/categories", getCategoriesByRestaurant);
router.patch(
  "/:restaurantId/menu/categories/reorder",
  validateRequest(reorderMenuCategoriesSchema),
  reorderCategories
);
router.post("/:restaurantId/menu/items", validateRequest(createMenuItemSchema), addMenuItem);
router.get("/:restaurantId/menu/items", getMenuItemsByRestaurant);
router.post("/:restaurantId/menu/import", uploadMenuImportFile, importMenuFile);
router.get("/:restaurantId", getRestaurantById);
router.post(
  "/:restaurantId/subscription/mark-paid",
  validateRequest(markSubscriptionPaidSchema),
  markSubscriptionPaid
);
router.patch("/:restaurantId", validateRequest(updateRestaurantSchema), updateRestaurant);
router.patch(
  "/:restaurantId/status",
  validateRequest(updateRestaurantStatusSchema),
  updateRestaurantStatus
);
router.patch("/:restaurantId/plan", validateRequest(updateRestaurantPlanSchema), updateRestaurantPlan);
router.delete("/:restaurantId", deleteRestaurant);

export default router;
