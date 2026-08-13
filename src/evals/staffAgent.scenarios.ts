import type { SenderRole } from "../types/agent.types";
import type { StaffOperationalState } from "../services/ai/staffOperationalState.service";
import { getAllowedToolNamesForRole } from "../agent-tools/tool.permissions";

export interface StaffAgentEvalScenario {
  name: string;
  role: Extract<SenderRole, "owner" | "manager">;
  message: string;
  expectedTool?: string;
  expectedArguments?: Record<string, unknown>;
  expectNoTool?: boolean;
  forbiddenTools?: string[];
  staffState?: StaffOperationalState;
}

const baseStaffState = (
  role: Extract<SenderRole, "owner" | "manager">,
  overrides: Partial<StaffOperationalState> = {}
): StaffOperationalState => ({
  pendingActions: [],
  imageWorkflow: null,
  orders: {
    freshPending: [],
    recentActive: []
  },
  recentReferences: {},
  permissions: getAllowedToolNamesForRole(role),
  ...overrides
});

const pendingOrder = {
  id: "64b000000000000000000101",
  orderNumber: "ORD-101",
  status: "pending",
  customerName: "Ama",
  total: 72
};

const activeOrder = {
  id: "64b000000000000000000202",
  orderNumber: "ORD-202",
  status: "preparing",
  customerName: "Kojo",
  total: 55
};

const imageState = (
  stage: "awaiting_image" | "awaiting_item" | "awaiting_confirmation"
): StaffOperationalState =>
  baseStaffState("owner", {
    imageWorkflow: {
      active: true,
      type: "menu_item_image",
      stage,
      imageUploaded: stage !== "awaiting_image",
      itemId: stage === "awaiting_confirmation" ? "menu-jollof" : undefined,
      itemName: stage === "awaiting_confirmation" ? "Jollof Rice" : undefined,
      pendingActionId: "image-action-1"
    }
  });

export const staffAgentScenarios: StaffAgentEvalScenario[] = [
  {
    name: "Owner menu read",
    role: "owner",
    message: "show me our menu",
    expectedTool: "get_menu"
  },
  {
    name: "Owner price update",
    role: "owner",
    message: "make jollof 45 cedis",
    expectedTool: "update_menu_price",
    expectedArguments: { itemName: "jollof", newPrice: 45 }
  },
  {
    name: "Informal owner price update",
    role: "owner",
    message: "boss make fried rice 40",
    expectedTool: "update_menu_price",
    expectedArguments: { itemName: "fried rice", newPrice: 40 }
  },
  {
    name: "Manager price permission",
    role: "manager",
    message: "change jollof price to 45",
    expectNoTool: true,
    forbiddenTools: ["update_menu_price"]
  },
  {
    name: "Availability off",
    role: "manager",
    message: "we've run out of fried rice",
    expectedTool: "set_item_availability",
    expectedArguments: { itemName: "fried rice", available: false }
  },
  {
    name: "Informal availability off",
    role: "owner",
    message: "jollof no dey again",
    expectedTool: "set_item_availability",
    expectedArguments: { itemName: "jollof", available: false }
  },
  {
    name: "Availability on",
    role: "manager",
    message: "fried rice is back, mark it available",
    expectedTool: "set_item_availability",
    expectedArguments: { itemName: "fried rice", available: true }
  },
  {
    name: "Add complete menu item",
    role: "owner",
    message: "add waakye for 35 cedis under main meals",
    expectedTool: "add_menu_items"
  },
  {
    name: "Add menu item missing details",
    role: "owner",
    message: "add salads",
    expectNoTool: true,
    forbiddenTools: ["add_menu_items"]
  },
  {
    name: "Accept explicit order",
    role: "owner",
    message: "accept order ORD-101",
    expectedTool: "confirm_order",
    expectedArguments: { orderReference: "ORD-101" }
  },
  {
    name: "Accept unique pending order",
    role: "manager",
    message: "that order accept am",
    expectedTool: "confirm_order",
    staffState: baseStaffState("manager", {
      orders: { freshPending: [pendingOrder], recentActive: [] }
    })
  },
  {
    name: "Reject with supplied reason",
    role: "owner",
    message: "reject ORD-101, chicken finish",
    expectedTool: "reject_order",
    expectedArguments: { orderReference: "ORD-101", reason: "chicken finish" }
  },
  {
    name: "Reject without reason",
    role: "owner",
    message: "reject ORD-101",
    expectNoTool: true,
    forbiddenTools: ["reject_order"]
  },
  {
    name: "Complete explicit order",
    role: "manager",
    message: "mark ORD-202 completed",
    expectedTool: "update_order_status",
    expectedArguments: { orderReference: "ORD-202", status: "completed" }
  },
  {
    name: "Complete unique active order",
    role: "owner",
    message: "order done",
    expectedTool: "update_order_status",
    expectedArguments: { status: "completed" },
    staffState: baseStaffState("owner", {
      orders: { freshPending: [], recentActive: [activeOrder] }
    })
  },
  {
    name: "Quoted order acceptance",
    role: "owner",
    message: "accept this one",
    expectedTool: "confirm_order",
    staffState: baseStaffState("owner", {
      recentReferences: { quotedOrder: pendingOrder }
    })
  },
  {
    name: "Ambiguous pending orders",
    role: "manager",
    message: "accept the order",
    expectNoTool: true,
    forbiddenTools: ["confirm_order", "reject_order"],
    staffState: baseStaffState("manager", {
      orders: {
        freshPending: [
          pendingOrder,
          { ...pendingOrder, id: "64b000000000000000000102", orderNumber: "ORD-102" }
        ],
        recentActive: []
      }
    })
  },
  {
    name: "Start image replacement",
    role: "owner",
    message: "the jollof pic I wan change am",
    expectedTool: "start_menu_item_image_upload",
    expectedArguments: { itemName: "jollof" }
  },
  {
    name: "Awaiting actual image",
    role: "owner",
    message: "okay I will send it",
    expectNoTool: true,
    staffState: imageState("awaiting_image")
  },
  {
    name: "Assign uploaded image",
    role: "owner",
    message: "use it for jollof rice",
    expectedTool: "assign_pending_image_to_menu_item",
    expectedArguments: { pendingActionId: "image-action-1", itemName: "jollof rice" },
    staffState: imageState("awaiting_item")
  },
  {
    name: "Confirm image assignment",
    role: "owner",
    message: "yes use that picture",
    expectedTool: "confirm_pending_image_assignment",
    expectedArguments: { pendingActionId: "image-action-1" },
    staffState: imageState("awaiting_confirmation")
  },
  {
    name: "Cancel image assignment",
    role: "owner",
    message: "cancel the image change",
    expectedTool: "cancel_pending_image_assignment",
    expectedArguments: { pendingActionId: "image-action-1" },
    staffState: imageState("awaiting_confirmation")
  },
  {
    name: "Create campaign draft",
    role: "manager",
    message: "create a campaign called Friday Special saying Get 10% off Friday for all eligible customers",
    expectedTool: "create_campaign_draft"
  },
  {
    name: "Update campaign draft",
    role: "owner",
    message: "change that campaign message to Get 15% off Friday",
    expectedTool: "update_campaign_draft",
    staffState: baseStaffState("owner", {
      recentReferences: {
        campaign: {
          id: "campaign-1",
          campaignVersion: 2,
          pendingActionId: "campaign-action-1",
          status: "pending_approval"
        }
      }
    })
  },
  {
    name: "Explicit campaign approval",
    role: "owner",
    message: "approve the Friday campaign",
    expectedTool: "approve_campaign",
    staffState: baseStaffState("owner", {
      recentReferences: {
        campaign: {
          id: "campaign-1",
          campaignVersion: 2,
          pendingActionId: "campaign-action-1",
          status: "pending_approval"
        }
      }
    })
  },
  {
    name: "Generic confirmation is ambiguous",
    role: "owner",
    message: "confirm",
    expectNoTool: true,
    forbiddenTools: ["approve_campaign", "confirm_order", "confirm_pending_image_assignment"],
    staffState: baseStaffState("owner", {
      pendingActions: [
        {
          actionId: "menu-action-1",
          type: "TOOL_CALL",
          toolName: "update_menu_price",
          status: "pending",
          requiresConfirmation: true
        },
        {
          actionId: "campaign-action-1",
          type: "TOOL_CALL",
          toolName: "approve_campaign",
          status: "pending",
          requiresConfirmation: true
        }
      ]
    })
  },
  {
    name: "Create reminder",
    role: "owner",
    message: "remind me tomorrow at 8 to call supplier",
    expectedTool: "create_staff_reminder"
  },
  {
    name: "Informal reminder",
    role: "manager",
    message: "remind me make I call supplier tomorrow 8",
    expectedTool: "create_staff_reminder"
  },
  {
    name: "Reschedule reminder",
    role: "owner",
    message: "move reminder reminder-1 to tomorrow at 10",
    expectedTool: "reschedule_staff_reminder",
    expectedArguments: { reminderId: "reminder-1" }
  },
  {
    name: "Cancel reminder",
    role: "manager",
    message: "cancel reminder reminder-2",
    expectedTool: "cancel_staff_reminder",
    expectedArguments: { reminderId: "reminder-2" }
  },
  {
    name: "Today's full report",
    role: "owner",
    message: "give me today's report",
    expectedTool: "get_business_report",
    expectedArguments: { period: "today" }
  },
  {
    name: "Today's revenue question",
    role: "manager",
    message: "how much we make today",
    expectedTool: "get_business_report",
    expectedArguments: { period: "today" }
  },
  {
    name: "Informal sales question",
    role: "owner",
    message: "how sales go today",
    expectedTool: "get_business_report",
    expectedArguments: { period: "today" }
  },
  {
    name: "Best seller this week",
    role: "manager",
    message: "what be our best seller this week?",
    expectedTool: "get_business_report",
    expectedArguments: { period: "this_week" }
  },
  {
    name: "Compare this week",
    role: "owner",
    message: "compare this week with last week",
    expectedTool: "get_business_report",
    expectedArguments: { period: "this_week", compareWithPrevious: true }
  },
  {
    name: "Lifetime customer count",
    role: "owner",
    message: "How many customers do we have now?",
    expectedTool: "get_business_summary"
  },
  {
    name: "Greeting",
    role: "owner",
    message: "hello boss",
    expectNoTool: true
  },
  {
    name: "Thanks",
    role: "manager",
    message: "thanks boss",
    expectNoTool: true
  },
  {
    name: "Presence check",
    role: "owner",
    message: "are you there?",
    expectNoTool: true
  },
  {
    name: "Conversational clarification",
    role: "manager",
    message: "what do you mean?",
    expectNoTool: true
  }
];
