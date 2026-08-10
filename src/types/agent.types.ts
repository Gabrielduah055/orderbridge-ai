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
  customerName?: string;
  message: string;
  quotedMessageId?: string;
  inboundEventId?: string;
}

export interface MenuItemImageDelivery {
  menuItemId?: string;
  imageUrl: string;
  caption: string;
  source: "menu_item_record" | "search_menu_items_tool";
}

export interface RestaurantAgentResponse {
  success: boolean;
  message: string;
  data?: {
    order?: IOrderDocument;
    orderEvent?: "submitted" | "confirmed" | "rejected";
    notifyOwner?: boolean;
    notifyCustomer?: boolean;
    receiptRequired?: boolean;
    pendingActionId?: string;
    menuItemImage?: MenuItemImageDelivery;
    [key: string]: unknown;
  };
  source?: "openrouter_agent" | "hermes_agent" | "hermes_tools" | "legacy_owner" | "legacy_customer";
  sender?: ResolvedSender;
}

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
  originalMessage?: string;
  quotedMessageId?: string;
  confirmed?: boolean;
  trustedStaffOrderSelection?: {
    decision: "accept" | "reject";
    awaitingReason: boolean;
    rejectionReason?: string;
    candidates: Array<{
      id: string;
      orderNumber?: string;
    }>;
  };
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
