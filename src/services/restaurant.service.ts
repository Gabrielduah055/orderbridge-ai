import { Types } from "mongoose";
import { Restaurant, type IRestaurantDocument } from "../models/Restaurant";
import type {
  RestaurantManagerContactInput,
  RestaurantInput,
  RestaurantPlan,
  RestaurantStatus,
  RestaurantUpdateInput
} from "../types/restaurant.types";
import { normalizeGhanaPhone, normalizePhoneList } from "../utils/phone.util";
import { generateUniqueRestaurantSlug } from "../utils/slug.util";
import { validateManagerLimit } from "./plan.service";

export class NotFoundError extends Error {
  statusCode = 404;

  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class BadRequestError extends Error {
  statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

const ensureValidObjectId = (restaurantId: string): void => {
  if (!Types.ObjectId.isValid(restaurantId)) {
    throw new BadRequestError("Invalid restaurantId");
  }
};

const findRestaurantOrThrow = async (restaurantId: string): Promise<IRestaurantDocument> => {
  ensureValidObjectId(restaurantId);
  const restaurant = await Restaurant.findById(restaurantId);

  if (!restaurant) {
    throw new NotFoundError("Restaurant not found");
  }

  return restaurant;
};

const normalizeManagerContacts = (
  managers: RestaurantManagerContactInput[] = []
): RestaurantManagerContactInput[] => {
  return managers
    .map((manager) => ({
      ...manager,
      phone: normalizeGhanaPhone(manager.phone)
    }))
    .filter((manager) => Boolean(manager.phone));
};

export const createRestaurant = async (
  input: RestaurantInput
): Promise<IRestaurantDocument> => {
  const plan = input.plan ?? "starter";
  const managerPhones = normalizePhoneList(input.managerPhones);
  validateManagerLimit(plan, managerPhones);

  const slug = await generateUniqueRestaurantSlug(input.name);

  return Restaurant.create({
    ...input,
    slug,
    plan,
    ownerPhone: normalizeGhanaPhone(input.ownerPhone),
    whatsappNumber: normalizeGhanaPhone(input.whatsappNumber),
    managerPhones,
    managerContacts: normalizeManagerContacts(input.managerContacts)
  });
};

export const getRestaurants = async (): Promise<IRestaurantDocument[]> => {
  return Restaurant.find().sort({ createdAt: -1 });
};

export const getRestaurantById = async (
  restaurantId: string
): Promise<IRestaurantDocument> => {
  return findRestaurantOrThrow(restaurantId);
};

export const updateRestaurant = async (
  restaurantId: string,
  input: RestaurantUpdateInput
): Promise<IRestaurantDocument> => {
  const restaurant = await findRestaurantOrThrow(restaurantId);
  const nextPlan = input.plan ?? restaurant.plan;
  const managerPhones =
    input.managerPhones === undefined
      ? restaurant.managerPhones
      : normalizePhoneList(input.managerPhones);

  validateManagerLimit(nextPlan, managerPhones);

  if (input.name && input.name !== restaurant.name) {
    restaurant.slug = await generateUniqueRestaurantSlug(input.name);
  }

  Object.assign(restaurant, {
    ...input,
    ...(input.ownerPhone ? { ownerPhone: normalizeGhanaPhone(input.ownerPhone) } : {}),
    ...(input.whatsappNumber ? { whatsappNumber: normalizeGhanaPhone(input.whatsappNumber) } : {}),
    ...(input.managerContacts ? { managerContacts: normalizeManagerContacts(input.managerContacts) } : {}),
    managerPhones
  });

  return restaurant.save();
};

export const updateRestaurantStatus = async (
  restaurantId: string,
  status: RestaurantStatus
): Promise<IRestaurantDocument> => {
  const restaurant = await findRestaurantOrThrow(restaurantId);
  restaurant.status = status;
  return restaurant.save();
};

export const updateRestaurantPlan = async (
  restaurantId: string,
  plan: RestaurantPlan
): Promise<IRestaurantDocument> => {
  const restaurant = await findRestaurantOrThrow(restaurantId);
  validateManagerLimit(plan, restaurant.managerPhones);
  restaurant.plan = plan;
  return restaurant.save();
};

export const deleteRestaurant = async (restaurantId: string): Promise<void> => {
  ensureValidObjectId(restaurantId);
  const result = await Restaurant.findByIdAndDelete(restaurantId);

  if (!result) {
    throw new NotFoundError("Restaurant not found");
  }
};
