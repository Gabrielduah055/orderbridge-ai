import type { SenderRole } from "../types/agent.types";
import type { AgentPermissionContext, BusinessCapability } from "../types/business.types";

export const toolPermissions = {
  get_restaurant_profile: ["owner", "manager", "customer"],
  get_menu: ["owner", "manager", "customer"],
  search_menu_items: ["owner", "manager", "customer"],
  get_today_orders: ["owner", "manager"],
  get_yesterday_orders: ["owner"],
  list_orders: ["owner", "manager"],
  list_customer_feedback: ["owner", "manager"],
  resolve_customer_feedback: ["owner", "manager"],
  get_sales_summary: ["owner"],
  get_business_report: ["owner"],
  get_item_performance: ["owner"],
  list_customers: ["owner"],
  get_customer_insights: ["owner"],
  get_customer_segment_insights: ["owner"],
  send_customer_message: ["owner", "manager"],
  get_latest_customer_order: ["customer"],
  respond_to_order_check_in: ["customer"],
  get_customer_recommendations: ["customer"],
  get_marketing_preference: ["customer"],
  get_order_details: ["owner", "manager", "customer"],
  get_business_summary: ["owner"],
  invite_customers_to_marketing: ["owner"],
  create_campaign_draft: ["owner"],
  update_campaign_draft: ["owner"],
  preview_campaign: ["owner"],
  approve_campaign: ["owner"],
  cancel_campaign: ["owner"],
  list_campaigns: ["owner"],
  start_campaign_image_upload: ["owner"],
  create_staff_reminder: ["owner", "manager"],
  list_staff_reminders: ["owner", "manager"],
  reschedule_staff_reminder: ["owner", "manager"],
  cancel_staff_reminder: ["owner", "manager"],
  add_menu_items: ["owner"],
  update_menu_price: ["owner"],
  set_item_availability: ["owner", "manager"],
  start_menu_item_image_upload: ["owner"],
  assign_pending_image_to_menu_item: ["owner"],
  confirm_pending_image_assignment: ["owner"],
  cancel_pending_image_assignment: ["owner"],
  remove_menu_item_image: ["owner"],
  confirm_order: ["owner", "manager"],
  reject_order: ["owner", "manager"],
  resolve_customer_cancellation_request: ["owner", "manager"],
  update_order_status: ["owner", "manager"],
  create_order: [],
  cancel_order: ["owner", "manager", "customer"],
  amend_submitted_order: ["customer"],
  get_delivery_information: ["owner", "manager", "customer"],
  start_order: ["customer"],
  add_order_item_by_name: ["customer"],
  remove_order_item_by_name: ["customer"],
  update_order_item_quantity: ["customer"],
  update_order_draft: ["customer"],
  get_order_draft: ["customer"],
  confirm_order_draft: ["customer"],
  cancel_order_draft: ["customer"],
  search_products: ["customer"],
  get_product_details: ["customer"],
  check_product_availability: ["customer"],
  get_business_policies: ["customer"]
} as const satisfies Record<string, SenderRole[]>;

export type ToolName = keyof typeof toolPermissions;
export type CommerceToolName =
  | "search_products"
  | "get_product_details"
  | "check_product_availability"
  | "get_business_policies";
export type RestaurantToolName = Exclude<ToolName, CommerceToolName>;

const commerceToolNames = new Set<ToolName>([
  "search_products",
  "get_product_details",
  "check_product_availability",
  "get_business_policies"
]);

const requiredCapabilityByTool: Partial<Record<ToolName, BusinessCapability>> = {
  search_products: "commerce_catalog_read",
  get_product_details: "commerce_catalog_read",
  check_product_availability: "commerce_catalog_read",
  get_business_policies: "commerce_catalog_read"
};

export const isCommerceToolName = (toolName: string): toolName is CommerceToolName =>
  commerceToolNames.has(toolName as ToolName);

export const isToolAllowedForContext = (
  toolName: string,
  context: AgentPermissionContext
): boolean => {
  const roles = toolPermissions[toolName as ToolName] as readonly SenderRole[] | undefined;

  if (!roles?.includes(context.senderRole)) {
    return false;
  }

  if (isCommerceToolName(toolName)) {
    const requiredCapability = requiredCapabilityByTool[toolName];
    return (
      context.businessType === "ecommerce" &&
      (context.channel === "website" || context.channel === "whatsapp") &&
      Boolean(requiredCapability && context.capabilities.includes(requiredCapability))
    );
  }

  return context.businessType === "restaurant" && context.channel === "whatsapp";
};

export const isToolAllowedForRole = (toolName: string, role: SenderRole): boolean => {
  return isToolAllowedForContext(toolName, {
    senderRole: role,
    businessType: "restaurant",
    channel: "whatsapp",
    capabilities: ["restaurant_operations", "restaurant_ordering", "whatsapp_chat"]
  });
};

export const getAllowedToolNamesForRole = (role: SenderRole): ToolName[] => {
  return getAllowedToolNamesForContext({
    senderRole: role,
    businessType: "restaurant",
    channel: "whatsapp",
    capabilities: ["restaurant_operations", "restaurant_ordering", "whatsapp_chat"]
  });
};

export const getAllowedToolNamesForContext = (
  context: AgentPermissionContext
): ToolName[] => {
  return (Object.keys(toolPermissions) as ToolName[]).filter((toolName) =>
    isToolAllowedForContext(toolName, context)
  );
};
