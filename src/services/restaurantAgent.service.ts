import {
  saveAgentConversationMessage
} from "./agentConversationHistory.service";
import { isHermesAgentConfigured, sendHermesAgentMessage } from "./hermesAgent.service";
import { resolveSenderIdentity } from "./senderIdentity.service";
import type {
  RestaurantAgentMessageInput,
  RestaurantAgentResponse
} from "../types/agent.types";

const temporaryHermesErrorMessage =
  "I'm having trouble reaching the restaurant assistant right now. Please try again in a few minutes.";

const normalizeText = (value: string): string => value.trim().replace(/\s+/g, " ");

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
