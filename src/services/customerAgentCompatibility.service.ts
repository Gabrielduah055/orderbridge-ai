import { Types } from "mongoose";
import { Restaurant, type IRestaurantDocument } from "../models/Restaurant";
import type { RestaurantAgentResponse } from "../types/agent.types";
import { BadRequestError, ForbiddenError, NotFoundError } from "../utils/httpErrors";
import { handleRestaurantAgentMessage } from "./restaurantAgent.service";
import { resolveSenderIdentity } from "./senderIdentity.service";

export interface CustomerCompatibilityMessageInput {
  restaurantId: string;
  customerPhone: string;
  customerName?: string;
  message: string;
}

export interface CustomerCompatibilityDependencies {
  findRestaurant?: (restaurantId: string) => Promise<IRestaurantDocument | null>;
  handleRestaurantMessage?: typeof handleRestaurantAgentMessage;
}

const defaultFindRestaurant = async (
  restaurantId: string
): Promise<IRestaurantDocument | null> => Restaurant.findById(restaurantId);

/**
 * Compatibility adapter for POST /agent/customer/message.
 *
 * It owns only restaurant/customer validation. Natural-language understanding
 * and tool selection belong to the shared restaurant agent used by WhatsApp.
 */
export const handleCustomerCompatibilityMessage = async (
  input: CustomerCompatibilityMessageInput,
  dependencies: CustomerCompatibilityDependencies = {}
): Promise<RestaurantAgentResponse> => {
  if (!Types.ObjectId.isValid(input.restaurantId)) {
    throw new BadRequestError("Invalid restaurantId");
  }

  const findRestaurant = dependencies.findRestaurant ?? defaultFindRestaurant;
  const restaurant = await findRestaurant(input.restaurantId);

  if (!restaurant) {
    throw new NotFoundError("Restaurant not found");
  }

  const sender = resolveSenderIdentity(restaurant, input.customerPhone);

  if (sender.role !== "customer") {
    throw new ForbiddenError("Staff phones must use the staff agent endpoint");
  }

  const routeToRestaurantAgent =
    dependencies.handleRestaurantMessage ?? handleRestaurantAgentMessage;

  return routeToRestaurantAgent({
    restaurant,
    senderPhone: input.customerPhone,
    customerName: input.customerName,
    message: input.message
  });
};
