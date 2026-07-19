import {
  saveAgentConversationMessage
} from "./agentConversationHistory.service";
import { executeAgentTool } from "../agent-tools/tool.executor";
import { isHermesAgentConfigured, sendHermesAgentMessage } from "./hermesAgent.service";
import { resolveSenderIdentity } from "./senderIdentity.service";
import type {
  RestaurantAgentMessageInput,
  RestaurantAgentResponse
} from "../types/agent.types";

const temporaryHermesErrorMessage =
  "I'm having trouble reaching the restaurant assistant right now. Please try again in a few minutes.";

const normalizeText = (value: string): string => value.trim().replace(/\s+/g, " ");

interface AgentMenuItemView {
  name?: unknown;
  price?: unknown;
  available?: unknown;
}

interface AgentMenuCategoryView {
  name?: unknown;
  active?: unknown;
  items?: unknown;
}

const isMenuRequest = (message: string): boolean => {
  const normalized = message.toLowerCase();

  return (
    /\b(menu|menus)\b/.test(normalized) &&
    /\b(show|list|see|view|display|send|what|today|available|have)\b/.test(normalized)
  );
};

const formatPrice = (price: unknown): string => {
  return typeof price === "number" && Number.isFinite(price) ? `GHS ${price}` : "Price not set";
};

const formatMenuResponse = (restaurantName: string, data: unknown): string => {
  const categories = Array.isArray(data) ? (data as AgentMenuCategoryView[]) : [];
  const sections = categories
    .map((category) => {
      const categoryName = typeof category.name === "string" ? category.name : "Menu";
      const categoryStatus = category.active === false ? " (inactive)" : "";
      const items = Array.isArray(category.items) ? (category.items as AgentMenuItemView[]) : [];
      const itemLines = items
        .map((item) => {
          const itemName = typeof item.name === "string" ? item.name : null;

          if (!itemName) {
            return null;
          }

          const availability = item.available === false ? " (unavailable)" : "";

          return `- ${itemName} - ${formatPrice(item.price)}${availability}`;
        })
        .filter((line): line is string => Boolean(line));

      if (itemLines.length === 0) {
        return null;
      }

      return [`*${categoryName}${categoryStatus}*`, ...itemLines].join("\n");
    })
    .filter((section): section is string => Boolean(section));

  if (sections.length === 0) {
    return `I couldn't find any menu items saved for ${restaurantName} yet.`;
  }

  return [`Here is the current menu for ${restaurantName}:`, ...sections].join("\n\n");
};

const handleLocalMenuRequest = async (
  input: RestaurantAgentMessageInput,
  sender: ReturnType<typeof resolveSenderIdentity>
): Promise<RestaurantAgentResponse> => {
  const restaurantId = String(input.restaurant._id);
  const result = await executeAgentTool(
    "get_menu",
    {
      availableOnly: sender.role === "customer"
    },
    {
      restaurantId,
      restaurant: input.restaurant,
      sender
    }
  );
  const message = result.success
    ? formatMenuResponse(input.restaurant.name, result.data)
    : result.message;

  await saveAgentConversationMessage({
    restaurantId,
    senderPhone: sender.normalizedPhone,
    senderRole: sender.role,
    direction: "assistant",
    content: message,
    metadata: {
      source: "hermes_tools",
      toolName: "get_menu",
      success: result.success,
      code: result.code
    }
  });

  return {
    success: result.success,
    message,
    data: result.data && typeof result.data === "object" ? { menu: result.data } : undefined,
    source: "hermes_tools",
    sender
  };
};

export const handleRestaurantAgentMessage = async (
  input: RestaurantAgentMessageInput
): Promise<RestaurantAgentResponse> => {
  const restaurantId = String(input.restaurant._id);
  const sender = resolveSenderIdentity(input.restaurant, input.senderPhone);
  const message = normalizeText(input.message);

  console.info("Restaurant agent sender resolved", {
    restaurantId,
    senderRole: sender.role,
    verified: sender.verified
  });

  await saveAgentConversationMessage({
    restaurantId,
    senderPhone: sender.normalizedPhone,
    senderRole: sender.role,
    direction: "user",
    content: message,
    metadata: {
      source: "hermes_agent"
    }
  });

  if (isMenuRequest(message)) {
    return handleLocalMenuRequest(input, sender);
  }

  if (!isHermesAgentConfigured()) {
    console.error("Hermes agent is not configured", {
      restaurantId,
      senderRole: sender.role
    });

    await saveAgentConversationMessage({
      restaurantId,
      senderPhone: sender.normalizedPhone,
      senderRole: sender.role,
      direction: "assistant",
      content: temporaryHermesErrorMessage,
      metadata: {
        source: "hermes_agent",
        error: "not_configured"
      }
    });

    return {
      success: false,
      message: temporaryHermesErrorMessage,
      source: "hermes_agent",
      sender
    };
  }

  const hermesAgentResult = await sendHermesAgentMessage(input.restaurant, sender, message);

  if (!hermesAgentResult) {
    await saveAgentConversationMessage({
      restaurantId,
      senderPhone: sender.normalizedPhone,
      senderRole: sender.role,
      direction: "assistant",
      content: temporaryHermesErrorMessage,
      metadata: {
        source: "hermes_agent",
        error: "unavailable"
      }
    });

    return {
      success: false,
      message: temporaryHermesErrorMessage,
      source: "hermes_agent",
      sender
    };
  }

  await saveAgentConversationMessage({
    restaurantId,
    senderPhone: sender.normalizedPhone,
    senderRole: sender.role,
    direction: "assistant",
    content: hermesAgentResult.message,
    metadata: {
      source: "hermes_agent",
      responseId: hermesAgentResult.responseId
    }
  });

  return {
    success: true,
    message: hermesAgentResult.message,
    data: hermesAgentResult.data,
    source: "hermes_agent",
    sender
  };
};
