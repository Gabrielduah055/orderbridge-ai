import type { NextFunction, Request, Response } from "express";
import * as restaurantService from "../services/restaurant.service";

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

    res.status(200).json({
      success: true,
      message: "Restaurant plan updated successfully",
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

    res.status(200).json({
      success: true,
      message: "Restaurant deleted successfully"
    });
  } catch (error) {
    next(error);
  }
};
