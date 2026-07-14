import { AgentConversationMessage } from "../models/agentConversation.model";
import type { AgentHistoryMessage, SaveAgentMessageInput } from "../types/agent.types";

export const saveAgentConversationMessage = async (
  input: SaveAgentMessageInput
): Promise<void> => {
  await AgentConversationMessage.create({
    restaurantId: input.restaurantId,
    senderPhone: input.senderPhone,
    senderRole: input.senderRole,
    direction: input.direction,
    content: input.content,
    metadata: input.metadata
  });
};

export const getRecentAgentConversationHistory = async (
  restaurantId: string,
  senderPhone: string,
  limit = 12
): Promise<AgentHistoryMessage[]> => {
  const messages = await AgentConversationMessage.find({
    restaurantId,
    senderPhone
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
