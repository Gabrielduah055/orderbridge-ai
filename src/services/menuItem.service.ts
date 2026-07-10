import { Types } from "mongoose";
import { MenuItem, type IMenuItemDocument } from "../models/MenuItem";
import type { MenuItemInput, MenuItemUpdateInput } from "../types/menu.types";
import { BadRequestError, NotFoundError } from "../utils/httpErrors";
import {
  ensureCategoryBelongsToRestaurant,
  ensureRestaurantExists,
  findCategoryOrThrow
} from "./menuCategory.service";

const ensureValidObjectId = (id: string, fieldName: string): void => {
  if (!Types.ObjectId.isValid(id)) {
    throw new BadRequestError(`Invalid ${fieldName}`);
  }
};

const findItemOrThrow = async (itemId: string): Promise<IMenuItemDocument> => {
  ensureValidObjectId(itemId, "itemId");
  const item = await MenuItem.findById(itemId);

  if (!item) {
    throw new NotFoundError("Menu item not found");
  }

  return item;
};

const ensurePositivePrice = (price?: number): void => {
  if (price !== undefined && price <= 0) {
    throw new BadRequestError("Price must be positive");
  }
};

export const addMenuItem = async (
  restaurantId: string,
  input: MenuItemInput
): Promise<IMenuItemDocument> => {
  await ensureRestaurantExists(restaurantId);
  await ensureCategoryBelongsToRestaurant(input.categoryId, restaurantId);
  ensurePositivePrice(input.price);

  return MenuItem.create({
    ...input,
    restaurantId,
    isAvailable: input.isAvailable ?? true,
    tags: input.tags ?? [],
    allergens: input.allergens ?? [],
    isPopular: input.isPopular ?? false,
    isPromoItem: input.isPromoItem ?? false
  });
};

export const getMenuItemsByRestaurant = async (
  restaurantId: string
): Promise<IMenuItemDocument[]> => {
  await ensureRestaurantExists(restaurantId);

  return MenuItem.find({ restaurantId }).sort({ createdAt: -1 });
};

export const getMenuItemsByCategory = async (
  categoryId: string
): Promise<IMenuItemDocument[]> => {
  const category = await findCategoryOrThrow(categoryId);

  return MenuItem.find({ categoryId: category._id }).sort({ createdAt: -1 });
};

export const updateMenuItem = async (
  itemId: string,
  input: MenuItemUpdateInput
): Promise<IMenuItemDocument> => {
  const item = await findItemOrThrow(itemId);
  ensurePositivePrice(input.price);

  if (input.categoryId) {
    await ensureCategoryBelongsToRestaurant(input.categoryId, String(item.restaurantId));
  }

  Object.assign(item, input);
  return item.save();
};

export const deactivateMenuItem = async (
  itemId: string
): Promise<IMenuItemDocument> => {
  const item = await findItemOrThrow(itemId);
  item.isAvailable = false;
  return item.save();
};

export const updateMenuItemAvailability = async (
  itemId: string,
  isAvailable: boolean
): Promise<IMenuItemDocument> => {
  const item = await findItemOrThrow(itemId);
  item.isAvailable = isAvailable;
  return item.save();
};

export const updateMenuItemImage = async (
  itemId: string,
  imageUrl: string
): Promise<IMenuItemDocument> => {
  const item = await findItemOrThrow(itemId);
  item.imageUrl = imageUrl;
  return item.save();
};
