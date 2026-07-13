import type { NextFunction, Request, Response } from "express";
import * as orderService from "../services/order.service";
import { generateOrderReceipt as generateReceipt } from "../services/receipt.service";

const getRestaurantId = (req: Request): string => {
  return String(req.params.restaurantId);
};

const getOrderId = (req: Request): string => {
  return String(req.params.orderId);
};

export const createOrder = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const order = await orderService.createOrder(getRestaurantId(req), req.body);

    res.status(201).json({
      success: true,
      message: "Order created successfully",
      data: order
    });
  } catch (error) {
    next(error);
  }
};

export const getOrdersByRestaurant = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const orders = await orderService.getOrdersByRestaurant(getRestaurantId(req));

    res.status(200).json({
      success: true,
      message: "Orders fetched successfully",
      data: orders
    });
  } catch (error) {
    next(error);
  }
};

export const getOrderById = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const order = await orderService.getOrderById(getOrderId(req));

    res.status(200).json({
      success: true,
      message: "Order fetched successfully",
      data: order
    });
  } catch (error) {
    next(error);
  }
};

export const updateOrderStatus = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const result = await orderService.updateOrderStatus(getOrderId(req), req.body.status);

    res.status(200).json({
      success: true,
      message: "Order status updated successfully",
      ...(result.warning ? { warning: result.warning } : {}),
      data: result.order
    });
  } catch (error) {
    next(error);
  }
};

export const generateOrderReceipt = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const receipt = await generateReceipt(getOrderId(req));

    res.status(200).json({
      success: true,
      message: "Receipt generated successfully",
      data: {
        receiptUrl: receipt.receiptUrl,
        order: receipt.order
      }
    });
  } catch (error) {
    next(error);
  }
};
