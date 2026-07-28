import { Schema, model, type Document, type Types } from "mongoose";
import type { SenderRole } from "../types/agent.types";

export const agentClarificationIntents = ["order_item_selection"] as const;
export const agentClarificationStatuses = ["pending", "resolved", "cancelled"] as const;

export type AgentClarificationIntent = (typeof agentClarificationIntents)[number];
export type AgentClarificationStatus = (typeof agentClarificationStatuses)[number];

export interface IAgentClarificationCandidate {
  menuItemId: Types.ObjectId;
  name: string;
  categoryId?: Types.ObjectId;
  price: number;
  categoryName?: string;
  available: boolean;
}

export interface IAgentClarification {
  restaurantId: Types.ObjectId;
  senderPhone: string;
  senderRole: SenderRole;
  intent: AgentClarificationIntent;
  status: AgentClarificationStatus;
  originalText: string;
  quantity?: number;
  candidates: IAgentClarificationCandidate[];
  expiresAt: Date;
  resolvedAt?: Date;
}

export interface IAgentClarificationDocument extends IAgentClarification, Document {
  createdAt: Date;
  updatedAt: Date;
}

const agentClarificationCandidateSchema = new Schema<IAgentClarificationCandidate>(
  {
    menuItemId: {
      type: Schema.Types.ObjectId,
      ref: "MenuItem",
      required: true
    },
    name: {
      type: String,
      required: true,
      trim: true
    },
    categoryId: {
      type: Schema.Types.ObjectId,
      ref: "MenuCategory"
    },
    price: {
      type: Number,
      required: true,
      min: 0
    },
    categoryName: {
      type: String,
      trim: true
    },
    available: {
      type: Boolean,
      required: true
    }
  },
  {
    _id: false
  }
);

const agentClarificationSchema = new Schema<IAgentClarificationDocument>(
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
      required: true,
      enum: ["owner", "manager", "customer"]
    },
    intent: {
      type: String,
      required: true,
      enum: agentClarificationIntents
    },
    status: {
      type: String,
      required: true,
      enum: agentClarificationStatuses,
      default: "pending",
      index: true
    },
    originalText: {
      type: String,
      required: true,
      trim: true
    },
    quantity: {
      type: Number,
      min: 1
    },
    candidates: {
      type: [agentClarificationCandidateSchema],
      default: []
    },
    expiresAt: {
      type: Date,
      required: true,
      index: {
        expires: 0
      }
    },
    resolvedAt: {
      type: Date
    }
  },
  {
    timestamps: true
  }
);

agentClarificationSchema.index({
  restaurantId: 1,
  senderPhone: 1,
  intent: 1,
  status: 1,
  createdAt: -1
});

export const AgentClarification = model<IAgentClarificationDocument>(
  "AgentClarification",
  agentClarificationSchema
);
