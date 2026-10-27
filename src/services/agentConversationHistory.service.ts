import { AgentConversationMessage } from "../models/agentConversation.model";
import type { AgentHistoryMessage, SaveAgentMessageInput } from "../types/agent.types";

export const saveAgentConversationMessage = async (
  input: SaveAgentMessageInput
): Promise<void> => {
  const scope = "restaurantId" in input
    ? {
        restaurantId: input.restaurantId,
        senderPhone: input.senderPhone
      }
    : {
        businessId: input.businessId,
        businessType: input.businessType,
        channel: input.channel,
        conversationId: input.conversationId
      };

  await AgentConversationMessage.create({
    ...scope,
    senderRole: input.senderRole,
    direction: input.direction,
    content: input.content,
    metadata: input.metadata
  });
};

export const getRecentBusinessConversationHistory = async (
  businessId: string,
  channel: "whatsapp" | "website",
  conversationId: string,
  limit = 12
): Promise<AgentHistoryMessage[]> => {
  const messages = await AgentConversationMessage.find({
    businessId,
    channel,
    conversationId,
    direction: { $in: ["user", "assistant"] }
  })
    .sort({ createdAt: -1 })
    .limit(limit);

  return messages.reverse().map((message) => ({
    role: message.direction,
    content: message.content,
    metadata: message.metadata
  }));
};

export const getRecentAgentConversationHistory = async (
  restaurantId: string,
  senderPhone: string,
  limit = 12
): Promise<AgentHistoryMessage[]> => {
  const messages = await AgentConversationMessage.find({
    restaurantId,
    senderPhone,
    direction: { $in: ["user", "assistant"] }
  })
    .sort({ createdAt: -1 })
    .limit(limit);

  return messages.reverse().map((message) => ({
    role: message.direction,
    content: message.content,
    metadata: message.metadata
  }));
};

export const getLatestAssistantConversationMessage = async (
  restaurantId: string,
  senderPhone: string
) => {
  return AgentConversationMessage.findOne({
    restaurantId,
    senderPhone,
    direction: "assistant"
  }).sort({ createdAt: -1 });
};
