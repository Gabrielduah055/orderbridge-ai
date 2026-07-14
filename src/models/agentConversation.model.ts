import { Schema, model, type Document, type Types } from "mongoose";
import type { AgentConversationDirection, SenderRole } from "../types/agent.types";

export const agentConversationDirections = ["user", "assistant", "tool"] as const;

export interface IAgentConversationMessage {
  restaurantId: Types.ObjectId;
  senderPhone: string;
  senderRole: SenderRole;
  direction: AgentConversationDirection;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface IAgentConversationMessageDocument
  extends IAgentConversationMessage,
    Document {
  createdAt: Date;
  updatedAt: Date;
}

const agentConversationMessageSchema = new Schema<IAgentConversationMessageDocument>(
  {
    restaurantId: {
      type: Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true,
      index: true
    },
    senderPhone: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    senderRole: {
      type: String,
      enum: ["owner", "manager", "customer"],
      required: true
    },
    direction: {
      type: String,
      enum: agentConversationDirections,
      required: true
    },
    content: {
      type: String,
      required: true,
      trim: true
    },
    metadata: {
      type: Schema.Types.Mixed
    }
  },
  {
    timestamps: true
  }
);

agentConversationMessageSchema.index({
  restaurantId: 1,
  senderPhone: 1,
  createdAt: -1
});

export const AgentConversationMessage = model<IAgentConversationMessageDocument>(
  "AgentConversationMessage",
  agentConversationMessageSchema
);
