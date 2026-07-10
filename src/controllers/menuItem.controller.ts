import type { NextFunction, Request, Response } from "express";
import * as menuItemService from "../services/menuItem.service";
import { buildUploadFileUrl } from "../services/menuImport.service";
import { BadRequestError } from "../utils/httpErrors";

const getRestaurantId = (req: Request): string => {
  return String(req.params.restaurantId);
};

const getCategoryId = (req: Request): string => {
  return String(req.params.categoryId);
};

const getItemId = (req: Request): string => {
  return String(req.params.itemId);
};

export const addMenuItem = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const item = await menuItemService.addMenuItem(getRestaurantId(req), req.body);

    res.status(201).json({
      success: true,
      message: "Menu item created successfully",
      data: item
    });
  } catch (error) {
    next(error);
  }
};

export const getMenuItemsByRestaurant = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const items = await menuItemService.getMenuItemsByRestaurant(getRestaurantId(req));

    res.status(200).json({
      success: true,
      message: "Menu items fetched successfully",
      data: items
    });
  } catch (error) {
    next(error);
  }
};

export const getMenuItemsByCategory = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const items = await menuItemService.getMenuItemsByCategory(getCategoryId(req));

    res.status(200).json({
      success: true,
      message: "Category menu items fetched successfully",
      data: items
    });
  } catch (error) {
    next(error);
  }
};

export const updateMenuItem = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const item = await menuItemService.updateMenuItem(getItemId(req), req.body);

    res.status(200).json({
      success: true,
      message: "Menu item updated successfully",
      data: item
    });
  } catch (error) {
    next(error);
  }
};

export const deactivateMenuItem = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const item = await menuItemService.deactivateMenuItem(getItemId(req));

    res.status(200).json({
      success: true,
      message: "Menu item deactivated successfully",
      data: item
    });
  } catch (error) {
    next(error);
  }
};

export const updateMenuItemAvailability = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const item = await menuItemService.updateMenuItemAvailability(
      getItemId(req),
      req.body.isAvailable
    );

    res.status(200).json({
      success: true,
      message: "Menu item availability updated successfully",
      data: item
    });
  } catch (error) {
    next(error);
  }
};

export const uploadMenuItemImage = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.file) {
      throw new BadRequestError("Menu item image is required");
    }

    const imageUrl = buildUploadFileUrl("menu-items", req.file.filename);
    const item = await menuItemService.updateMenuItemImage(getItemId(req), imageUrl);

    res.status(200).json({
      success: true,
      message: "Menu item image uploaded successfully",
      imageUrl,
      data: item
    });
  } catch (error) {
    next(error);
  }
};
