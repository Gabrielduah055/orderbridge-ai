import { Types } from "mongoose";
import { MenuCategory, type IMenuCategoryDocument } from "../models/MenuCategory";
import { MenuItem } from "../models/MenuItem";
import { Restaurant } from "../models/Restaurant";
import type {
  CategorySortOrderInput,
  MenuCategoryInput,
  MenuCategoryUpdateInput
} from "../types/menu.types";
import { BadRequestError, NotFoundError } from "../utils/httpErrors";

export const defaultMenuCategoryNames = [
  "Main Meals",
  "Rice Dishes",
  "Soups & Stews",
  "Grills",
  "Snacks",
  "Drinks",
  "Desserts",
  "Combos",
  "Specials"
] as const;

const ensureValidObjectId = (id: string, fieldName: string): void => {
  if (!Types.ObjectId.isValid(id)) {
    throw new BadRequestError(`Invalid ${fieldName}`);
  }
};

export const ensureRestaurantExists = async (restaurantId: string): Promise<void> => {
  ensureValidObjectId(restaurantId, "restaurantId");
  const exists = await Restaurant.exists({ _id: restaurantId });

  if (!exists) {
    throw new NotFoundError("Restaurant not found");
  }
};

const getNextSortOrder = async (restaurantId: string): Promise<number> => {
  const lastCategory = await MenuCategory.findOne({ restaurantId })
    .sort({ sortOrder: -1 })
    .select("sortOrder");

  return lastCategory ? lastCategory.sortOrder + 10 : 0;
};

export const createDefaultCategoriesForRestaurant = async (
  restaurantId: string | Types.ObjectId
): Promise<IMenuCategoryDocument[]> => {
  const normalizedRestaurantId = String(restaurantId);
  const restaurantObjectId = new Types.ObjectId(normalizedRestaurantId);
  const existingCount = await MenuCategory.countDocuments({
    restaurantId: restaurantObjectId
  });

  if (existingCount > 0) {
    return MenuCategory.find({ restaurantId: restaurantObjectId }).sort({
      sortOrder: 1,
      createdAt: 1
    });
  }

  return MenuCategory.insertMany(
    defaultMenuCategoryNames.map((name, index) => ({
      restaurantId: restaurantObjectId,
      name,
      sortOrder: index * 10,
      isDefault: true,
      isActive: true
    }))
  );
};

export const createCategory = async (
  restaurantId: string,
  input: MenuCategoryInput
): Promise<IMenuCategoryDocument> => {
  await ensureRestaurantExists(restaurantId);

  return MenuCategory.create({
    restaurantId,
    name: input.name,
    description: input.description,
    sortOrder: input.sortOrder ?? (await getNextSortOrder(restaurantId)),
    isDefault: false,
    isActive: input.isActive ?? true
  });
};

export const getCategoriesByRestaurant = async (
  restaurantId: string,
  includeInactive = false
): Promise<IMenuCategoryDocument[]> => {
  await ensureRestaurantExists(restaurantId);

  return MenuCategory.find({
    restaurantId,
    ...(includeInactive ? {} : { isActive: true })
  }).sort({ sortOrder: 1, createdAt: 1 });
};

export const findCategoryOrThrow = async (
  categoryId: string
): Promise<IMenuCategoryDocument> => {
  ensureValidObjectId(categoryId, "categoryId");
  const category = await MenuCategory.findById(categoryId);

  if (!category) {
    throw new NotFoundError("Menu category not found");
  }

  return category;
};

export const ensureCategoryBelongsToRestaurant = async (
  categoryId: string,
  restaurantId: string
): Promise<IMenuCategoryDocument> => {
  const category = await findCategoryOrThrow(categoryId);

  if (String(category.restaurantId) !== restaurantId) {
    throw new BadRequestError("Category does not belong to this restaurant");
  }

  if (!category.isActive) {
    throw new BadRequestError("Category is inactive");
  }

  return category;
};

export const updateCategory = async (
  categoryId: string,
  input: MenuCategoryUpdateInput
): Promise<IMenuCategoryDocument> => {
  const category = await findCategoryOrThrow(categoryId);

  Object.assign(category, input);
  return category.save();
};

export const deactivateCategory = async (
  categoryId: string
): Promise<IMenuCategoryDocument> => {
  const category = await findCategoryOrThrow(categoryId);
  category.isActive = false;
  await category.save();

  await MenuItem.updateMany(
    { categoryId: category._id },
    { $set: { isAvailable: false } }
  );

  return category;
};

export const reorderCategories = async (
  restaurantId: string,
  categoryOrders: CategorySortOrderInput[]
): Promise<IMenuCategoryDocument[]> => {
  await ensureRestaurantExists(restaurantId);

  const categoryIds = categoryOrders.map((item) => item.categoryId);
  categoryIds.forEach((categoryId) => ensureValidObjectId(categoryId, "categoryId"));

  const categories = await MenuCategory.find({
    _id: { $in: categoryIds },
    restaurantId
  }).select("_id");

  if (categories.length !== categoryIds.length) {
    throw new BadRequestError("All categories must belong to this restaurant");
  }

  await MenuCategory.bulkWrite(
    categoryOrders.map((item) => ({
      updateOne: {
        filter: { _id: item.categoryId, restaurantId },
        update: { $set: { sortOrder: item.sortOrder } }
      }
    }))
  );

  return getCategoriesByRestaurant(restaurantId, true);
};
