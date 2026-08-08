import { Types } from "mongoose";
import { Restaurant, type IRestaurantDocument } from "../models/Restaurant";
import type { RestaurantAgentResponse } from "../types/agent.types";
import { BadRequestError, ForbiddenError, NotFoundError } from "../utils/httpErrors";
import { handleRestaurantAgentMessage } from "./restaurantAgent.service";
import { resolveSenderIdentity } from "./senderIdentity.service";

interface OwnerAgentMessageInput {
  restaurantId: string;
  senderPhone: string;
  message: string;
}

interface OwnerAgentDependencies {
  findRestaurant?: (restaurantId: string) => Promise<IRestaurantDocument | null>;
  handleRestaurantMessage?: typeof handleRestaurantAgentMessage;
}

const defaultFindRestaurant = async (
  restaurantId: string
): Promise<IRestaurantDocument | null> => Restaurant.findById(restaurantId);

/**
 * Compatibility adapter for the existing owner HTTP endpoint.
 *
 * Staff natural-language understanding belongs to the shared AI-first restaurant
 * agent. This adapter preserves the endpoint's restaurant lookup and staff-only
 * authorization boundary without maintaining a second regex intent parser.
 */
export const handleOwnerMessage = async (
  input: OwnerAgentMessageInput,
  dependencies: OwnerAgentDependencies = {}
): Promise<RestaurantAgentResponse> => {
  if (!Types.ObjectId.isValid(input.restaurantId)) {
    throw new BadRequestError("Invalid restaurantId");
  }

  const findRestaurant = dependencies.findRestaurant ?? defaultFindRestaurant;
  const restaurant = await findRestaurant(input.restaurantId);

  if (!restaurant) {
    throw new NotFoundError("Restaurant not found");
  }

  const sender = resolveSenderIdentity(restaurant, input.senderPhone);

  if (sender.role !== "owner" && sender.role !== "manager") {
    throw new ForbiddenError("Sender phone is not authorized for this restaurant");
  }

  const routeToRestaurantAgent =
    dependencies.handleRestaurantMessage ?? handleRestaurantAgentMessage;

  return routeToRestaurantAgent({
    restaurant,
    senderPhone: input.senderPhone,
    message: input.message
  });
};
