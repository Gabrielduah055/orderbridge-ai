import slugify from "slugify";
import { Restaurant } from "../models/Restaurant";

const randomSuffix = (): string => Math.random().toString(36).slice(2, 8);

export const createSlug = (value: string): string => {
  return slugify(value, {
    lower: true,
    strict: true,
    trim: true
  });
};

export const generateUniqueRestaurantSlug = async (name: string): Promise<string> => {
  const baseSlug = createSlug(name);
  let slug = baseSlug;
  let existingRestaurant = await Restaurant.exists({ slug });

  while (existingRestaurant) {
    slug = `${baseSlug}-${randomSuffix()}`;
    existingRestaurant = await Restaurant.exists({ slug });
  }

  return slug;
};
