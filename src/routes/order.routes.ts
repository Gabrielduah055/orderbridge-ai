import { Router } from "express";
import {
  createOrder,
  generateOrderReceipt,
  getOrderById,
  getOrdersByRestaurant,
  updateOrderStatus
} from "../controllers/order.controller";
import {
  createOrderSchema,
  updateOrderStatusSchema,
  validateRequest
} from "../middleware/validateRequest";

export const restaurantOrderRoutes = Router({
  mergeParams: true
});

restaurantOrderRoutes.post("/", validateRequest(createOrderSchema), createOrder);
restaurantOrderRoutes.get("/", getOrdersByRestaurant);

const router = Router();

router.post("/:orderId/receipt", generateOrderReceipt);
router.get("/:orderId", getOrderById);
router.patch("/:orderId/status", validateRequest(updateOrderStatusSchema), updateOrderStatus);

export default router;
