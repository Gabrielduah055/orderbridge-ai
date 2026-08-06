import type { SenderRole } from "../types/agent.types";

export const toolPermissions = {
  get_restaurant_profile: ["owner", "manager", "customer"],
  get_menu: ["owner", "manager", "customer"],
  search_menu_items: ["owner", "manager", "customer"],
  get_today_orders: ["owner", "manager"],
  get_yesterday_orders: ["owner", "manager"],
  list_orders: ["owner", "manager"],
  list_customer_feedback: ["owner", "manager"],
  resolve_customer_feedback: ["owner", "manager"],
  get_sales_summary: ["owner", "manager"],
  get_latest_customer_order: ["customer"],
  get_customer_recommendations: ["customer"],
  get_marketing_preference: ["customer"],
  get_order_details: ["owner", "manager", "customer"],
  get_business_summary: ["owner", "manager"],
  create_campaign_draft: ["owner", "manager"],
  preview_campaign: ["owner", "manager"],
  approve_campaign: ["owner", "manager"],
  cancel_campaign: ["owner", "manager"],
  list_campaigns: ["owner", "manager"],
  add_menu_items: ["owner"],
  update_menu_price: ["owner"],
  set_item_availability: ["owner", "manager"],
  set_menu_item_image: ["owner", "manager"],
  remove_menu_item_image: ["owner", "manager"],
  confirm_order: ["owner", "manager"],
  reject_order: ["owner", "manager"],
  update_order_status: ["owner", "manager"],
  create_order: [],
  cancel_order: ["owner", "manager", "customer"],
  get_delivery_information: ["owner", "manager", "customer"],
  start_order: ["customer"],
  add_order_item_by_name: ["customer"],
  remove_order_item_by_name: ["customer"],
  update_order_item_quantity: ["customer"],
  update_order_draft: ["customer"],
  get_order_draft: ["customer"],
  confirm_order_draft: ["customer"],
  cancel_order_draft: ["customer"]
} as const satisfies Record<string, SenderRole[]>;

export type ToolName = keyof typeof toolPermissions;

export const isToolAllowedForRole = (toolName: string, role: SenderRole): boolean => {
  const roles = toolPermissions[toolName as ToolName] as readonly SenderRole[] | undefined;

  return Boolean(roles?.includes(role));
};

export const getAllowedToolNamesForRole = (role: SenderRole): ToolName[] => {
  return (Object.keys(toolPermissions) as ToolName[]).filter((toolName) =>
    (toolPermissions[toolName] as readonly SenderRole[]).includes(role)
  );
};
