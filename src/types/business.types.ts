export const businessTypes = ["restaurant", "ecommerce"] as const;
export const businessStatuses = ["trial", "active", "paused", "cancelled"] as const;
export const agentChannels = ["whatsapp", "website"] as const;
export const businessCapabilities = [
  "restaurant_operations",
  "restaurant_ordering",
  "commerce_catalog_read",
  "website_chat",
  "whatsapp_chat"
] as const;

export type BusinessType = (typeof businessTypes)[number];
export type BusinessStatus = (typeof businessStatuses)[number];
export type AgentChannel = (typeof agentChannels)[number];
export type BusinessCapability = (typeof businessCapabilities)[number];

export interface AgentPermissionContext {
  senderRole: "owner" | "manager" | "customer";
  businessType: BusinessType;
  channel: AgentChannel;
  capabilities: readonly BusinessCapability[];
}

export interface TrustedBusinessContext {
  businessId: string;
  businessName: string;
  businessType: BusinessType;
  channel: AgentChannel;
  capabilities: BusinessCapability[];
  conversationId: string;
  timezone: string;
}
