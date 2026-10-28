import { Schema, model, type Document, type Types } from "mongoose";
import type { AgentConversationDirection, SenderRole } from "../types/agent.types";
import {
  agentChannels,
  businessTypes,
  type AgentChannel,
  type BusinessType
} from "../types/business.types";

export const agentConversationDirections = ["user", "assistant", "tool"] as const;

export interface IAgentConversationMessage {
  restaurantId?: Types.ObjectId;
  senderPhone?: string;
  businessId?: Types.ObjectId;
  businessType?: BusinessType;
  channel?: AgentChannel;
  conversationId?: string;
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
      index: true
    },
    senderPhone: {
      type: String,
      trim: true,
      index: true
    },
    businessId: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      index: true
    },
    businessType: {
      type: String,
      enum: businessTypes
    },
    channel: {
      type: String,
      enum: agentChannels
    },
    conversationId: {
      type: String,
      trim: true,
      maxlength: 160,
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
agentConversationMessageSchema.index({
  businessId: 1,
  channel: 1,
  conversationId: 1,
  createdAt: -1
});

agentConversationMessageSchema.pre("validate", function validateConversationScope(next) {
  const hasRestaurantScope = Boolean(this.restaurantId && this.senderPhone);
  const hasBusinessScope = Boolean(
    this.businessId && this.businessType && this.channel && this.conversationId
  );

  if (hasRestaurantScope === hasBusinessScope) {
    next(new Error("Conversation messages require exactly one trusted tenant scope"));
    return;
  }

  next();
});

export const AgentConversationMessage = model<IAgentConversationMessageDocument>(
  "AgentConversationMessage",
  agentConversationMessageSchema
);
