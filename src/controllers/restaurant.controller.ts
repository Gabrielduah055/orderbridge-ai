import type { NextFunction, Request, Response } from "express";
import * as restaurantService from "../services/restaurant.service";
import { recordSubscriptionPayment } from "../services/subscriptionBilling.service";
import { recordAdminAuditAfterMutation } from "../services/adminAudit.service";

const getRestaurantId = (req: Request): string => {
  return String(req.params.restaurantId);
};

export const createRestaurant = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const restaurant = await restaurantService.createRestaurant(req.body);

    await recordAdminAuditAfterMutation({
      actor: req.user!,
      action: "restaurant.create",
      targetType: "restaurant",
      targetId: String(restaurant._id),
      restaurantId: String(restaurant._id),
      changedFields: Object.keys(req.body ?? {})
    });

    res.status(201).json({
      success: true,
      message: "Restaurant created successfully",
      data: restaurant
    });
  } catch (error) {
    next(error);
  }
};

export const getRestaurants = async (
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const restaurants = await restaurantService.getRestaurants();

    res.status(200).json({
      success: true,
      message: "Restaurants fetched successfully",
      data: restaurants
    });
  } catch (error) {
    next(error);
  }
};

export const getRestaurantById = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const restaurant = await restaurantService.getRestaurantById(getRestaurantId(req));

    res.status(200).json({
      success: true,
      message: "Restaurant fetched successfully",
      data: restaurant
    });
  } catch (error) {
    next(error);
  }
};

export const updateRestaurant = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const restaurant = await restaurantService.updateRestaurant(getRestaurantId(req), req.body);

    await recordAdminAuditAfterMutation({
      actor: req.user!,
      action: "restaurant.update",
      targetType: "restaurant",
      targetId: String(restaurant._id),
      restaurantId: String(restaurant._id),
      changedFields: Object.keys(req.body ?? {})
    });

    res.status(200).json({
      success: true,
      message: "Restaurant updated successfully",
      data: restaurant
    });
  } catch (error) {
    next(error);
  }
};

export const updateRestaurantStatus = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const restaurant = await restaurantService.updateRestaurantStatus(
      getRestaurantId(req),
      req.body.status
    );

    await recordAdminAuditAfterMutation({
      actor: req.user!,
      action: "restaurant.status.update",
      targetType: "restaurant",
      targetId: String(restaurant._id),
      restaurantId: String(restaurant._id),
      changedFields: ["status"],
      metadata: { status: restaurant.status }
    });

    res.status(200).json({
      success: true,
      message: "Restaurant status updated successfully",
      data: restaurant
    });
  } catch (error) {
    next(error);
  }
};

export const updateRestaurantPlan = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const restaurant = await restaurantService.updateRestaurantPlan(
      getRestaurantId(req),
      req.body.plan
    );

    await recordAdminAuditAfterMutation({
      actor: req.user!,
      action: "restaurant.plan.update",
      targetType: "restaurant",
      targetId: String(restaurant._id),
      restaurantId: String(restaurant._id),
      changedFields: ["plan"],
      metadata: { plan: restaurant.plan }
    });

    res.status(200).json({
      success: true,
      message: "Restaurant plan updated successfully",
      data: restaurant
    });
  } catch (error) {
    next(error);
  }
};

export const markSubscriptionPaid = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const restaurant = await recordSubscriptionPayment(
      getRestaurantId(req),
      req.body
    );

    await recordAdminAuditAfterMutation({
      actor: req.user!,
      action: "restaurant.subscription.mark_paid",
      targetType: "restaurant",
      targetId: String(restaurant._id),
      restaurantId: String(restaurant._id),
      changedFields: ["subscriptionLastPaidAt", "subscriptionRenewalDate", "billingStatus"]
    });

    res.status(200).json({
      success: true,
      message: "Subscription payment recorded successfully",
      data: restaurant
    });
  } catch (error) {
    next(error);
  }
};

export const deleteRestaurant = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    await restaurantService.deleteRestaurant(getRestaurantId(req));

    await recordAdminAuditAfterMutation({
      actor: req.user!,
      action: "restaurant.delete",
      targetType: "restaurant",
      targetId: getRestaurantId(req),
      restaurantId: getRestaurantId(req)
    });

    res.status(200).json({
      success: true,
      message: "Restaurant deleted successfully"
    });
  } catch (error) {
    next(error);
  }
};
