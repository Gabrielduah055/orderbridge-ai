import type { NextFunction, Request, Response } from "express";
import * as menuCategoryService from "../services/menuCategory.service";

const getRestaurantId = (req: Request): string => {
  return String(req.params.restaurantId);
};

const getCategoryId = (req: Request): string => {
  return String(req.params.categoryId);
};

export const createCategory = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const category = await menuCategoryService.createCategory(getRestaurantId(req), req.body);

    res.status(201).json({
      success: true,
      message: "Menu category created successfully",
      data: category
    });
  } catch (error) {
    next(error);
  }
};

export const getCategoriesByRestaurant = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const includeInactive = req.query.includeInactive === "true";
    const categories = await menuCategoryService.getCategoriesByRestaurant(
      getRestaurantId(req),
      includeInactive
    );

    res.status(200).json({
      success: true,
      message: "Menu categories fetched successfully",
      data: categories
    });
  } catch (error) {
    next(error);
  }
};

export const updateCategory = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const category = await menuCategoryService.updateCategory(getCategoryId(req), req.body);

    res.status(200).json({
      success: true,
      message: "Menu category updated successfully",
      data: category
    });
  } catch (error) {
    next(error);
  }
};

export const deactivateCategory = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const category = await menuCategoryService.deactivateCategory(getCategoryId(req));

    res.status(200).json({
      success: true,
      message: "Menu category deactivated successfully",
      data: category
    });
  } catch (error) {
    next(error);
  }
};

export const reorderCategories = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const categories = await menuCategoryService.reorderCategories(
      getRestaurantId(req),
      req.body.categoryOrders
    );

    res.status(200).json({
      success: true,
      message: "Menu categories reordered successfully",
      data: categories
    });
  } catch (error) {
    next(error);
  }
};
