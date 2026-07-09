import { Router } from "express";
import {
  createRestaurant,
  deleteRestaurant,
  getRestaurantById,
  getRestaurants,
  updateRestaurant,
  updateRestaurantPlan,
  updateRestaurantStatus
} from "../controllers/restaurant.controller";
import { firebaseAuth } from "../middleware/firebaseAuth.middleware";
import { requireSuperAdmin } from "../middleware/requireSuperAdmin";
import {
  createRestaurantSchema,
  updateRestaurantPlanSchema,
  updateRestaurantSchema,
  updateRestaurantStatusSchema,
  validateRequest
} from "../middleware/validateRequest";

const router = Router();

router.use(firebaseAuth, requireSuperAdmin);

router.post("/", validateRequest(createRestaurantSchema), createRestaurant);
router.get("/", getRestaurants);
router.get("/:restaurantId", getRestaurantById);
router.patch("/:restaurantId", validateRequest(updateRestaurantSchema), updateRestaurant);
router.patch(
  "/:restaurantId/status",
  validateRequest(updateRestaurantStatusSchema),
  updateRestaurantStatus
);
router.patch("/:restaurantId/plan", validateRequest(updateRestaurantPlanSchema), updateRestaurantPlan);
router.delete("/:restaurantId", deleteRestaurant);

export default router;
