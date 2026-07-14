import type { SenderRole } from "../types/agent.types";

export const toolPermissions = {
  get_restaurant_profile: ["owner", "manager", "customer"],
  get_menu: ["owner", "manager", "customer"],
  search_menu_items: ["owner", "manager", "customer"],
  get_today_orders: ["owner", "manager"],
  get_order_details: ["owner", "manager", "customer"],
  get_business_summary: ["owner", "manager"],
  update_menu_price: ["owner"],
  set_item_availability: ["owner", "manager"],
  confirm_order: ["owner", "manager"],
  update_order_status: ["owner", "manager"],
  create_promotion: ["owner"],
  create_order: ["customer"],
  cancel_order: ["owner", "manager", "customer"],
  get_delivery_information: ["owner", "manager", "customer"]
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
