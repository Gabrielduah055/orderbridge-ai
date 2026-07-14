import type { z } from "zod";
import type { IOrderDocument } from "../models/order.model";
import type { IRestaurantDocument } from "../models/Restaurant";

export type SenderRole = "owner" | "manager" | "customer";

export interface ResolvedSender {
  name?: string;
  phone: string;
  normalizedPhone: string;
  role: SenderRole;
  verified: boolean;
}

export interface RestaurantAgentContext {
  restaurant: {
    id: string;
    name: string;
    slug?: string;
    cuisine?: string;
    location?: string;
    status?: string;
  };
  sender: {
    name?: string;
    phone: string;
    role: SenderRole;
    verified: boolean;
  };
  people: {
    ownerName?: string;
    managerName?: string;
  };
  settings: {
    deliveryEnabled?: boolean;
    deliveryRadiusKm?: number;
    minimumOrderValue?: number;
    takeawayEnabled?: boolean;
    freeDeliveryThresholdEnabled?: boolean;
    deliveryFeeNote?: string;
    openingHours?: string;
    assistantTone?: string;
  };
  summary: {
    activeCategories: number;
    activeMenuItems: number;
    unavailableMenuItems: number;
    activeOrders: number;
    activePromotions?: number;
  };
  permissions: string[];
}

export interface RestaurantAgentMessageInput {
  restaurant: IRestaurantDocument;
  senderPhone: string;
  message: string;
}

export interface RestaurantAgentResponse {
  success: boolean;
  message: string;
  data?: {
    order?: IOrderDocument;
    [key: string]: unknown;
  };
  source?: "hermes_tools" | "legacy_owner" | "legacy_customer";
  sender?: ResolvedSender;
}

export type HermesChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type HermesAgentTurn =
  | {
      type: "message";
      message: string;
    }
  | {
      type: "tool_call";
      toolName: string;
      arguments?: Record<string, unknown>;
    };

export type AgentConversationDirection = "user" | "assistant" | "tool";

export interface AgentHistoryMessage {
  role: AgentConversationDirection;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface SaveAgentMessageInput {
  restaurantId: string;
  senderPhone: string;
  senderRole: SenderRole;
  direction: AgentConversationDirection;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ToolExecutionContext {
  restaurantId: string;
  restaurant: IRestaurantDocument;
  sender: ResolvedSender;
  requestId?: string;
  confirmed?: boolean;
}

export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  code?: string;
  message: string;
  requiresConfirmation?: boolean;
  pendingActionId?: string;
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ToolHandler<TArgs = Record<string, unknown>, TResult = unknown> = (
  args: TArgs,
  context: ToolExecutionContext
) => Promise<ToolResult<TResult>>;

export interface RegisteredTool<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  definition: AgentToolDefinition;
  roles: SenderRole[];
  schema: TSchema;
  sensitive?: boolean;
  handler: ToolHandler<z.infer<TSchema>>;
}
