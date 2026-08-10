import type { AiMessage } from "../services/ai/ai.types";
import type {
  FeedbackFollowUpStatus,
  OrderStatus
} from "../models/order.model";

export interface SyntheticCustomerDraft {
  customerName?: string;
  cartItems?: Array<{
    menuItemId: string;
    name: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
  }>;
  pendingMenuItemId?: string;
  pendingMenuItemName?: string;
  currentStep?: string;
  orderType?: "pickup" | "delivery" | null;
  deliveryAddress?: string;
  deliveryFee?: number;
  deliveryFeeSource?: string;
  deliveryFeeResolved?: boolean;
}

export interface CustomerAgentEvalScenario {
  name: string;
  message: string;
  history?: AiMessage[];
  expectedTool?: string;
  expectedOneOfTools?: string[];
  expectedArguments?: Record<string, unknown>;
  forbiddenArguments?: string[];
  allowNoTool?: boolean;
  expectNoTool?: boolean;
  forbiddenTools?: string[];
  expectedTextPattern?: RegExp;
  deterministicBoundary?: boolean;
  activeDraft?: SyntheticCustomerDraft;
  activeClarification?: {
    intent: string;
    originalText: string;
    candidates: Array<{
      menuItemId: string;
      name: string;
      price: number;
      available: boolean;
    }>;
  };
  activeOrderCheckIns?: Array<{
    orderNumber: string;
    orderType: "pickup" | "delivery";
    status: OrderStatus;
    checkInStatus: FeedbackFollowUpStatus;
    awaitingComplaint: boolean;
    receiptClarificationPending: boolean;
  }>;
}

const customerMutations = [
  "start_order",
  "add_order_item_by_name",
  "remove_order_item_by_name",
  "update_order_item_quantity",
  "update_order_draft",
  "confirm_order_draft",
  "cancel_order_draft",
  "cancel_order"
];

const draft = (
  overrides: SyntheticCustomerDraft = {}
): SyntheticCustomerDraft => ({
  customerName: "Ruth",
  cartItems: [],
  currentStep: "idle",
  orderType: null,
  deliveryFeeResolved: false,
  ...overrides
});

const chickenDraft = draft({
  cartItems: [
    {
      menuItemId: "64b000000000000000000301",
      name: "Chicken Salad",
      quantity: 2,
      unitPrice: 35,
      totalPrice: 70
    }
  ],
  currentStep: "choosing_items"
});

const completeDraft = draft({
  cartItems: chickenDraft.cartItems,
  currentStep: "confirming_order",
  orderType: "pickup",
  deliveryFee: 0,
  deliveryFeeSource: "pickup",
  deliveryFeeResolved: true
});

export const customerAgentScenarios: CustomerAgentEvalScenario[] = [
  {
    name: "Greeting",
    message: "Hi",
    expectNoTool: true,
    forbiddenTools: customerMutations
  },
  { name: "Menu", message: "send me the menu", expectedTool: "get_menu" },
  {
    name: "Item search",
    message: "do you have chicken salad?",
    expectedTool: "search_menu_items",
    expectedArguments: { query: "chicken salad" }
  },
  {
    name: "Image",
    message: "show me Chicken Salad",
    expectedTool: "search_menu_items",
    expectedArguments: { query: "Chicken Salad", includeImage: true }
  },
  {
    name: "Image informal",
    message: "any pic of Chicken Salad?",
    expectedTool: "search_menu_items",
    expectedArguments: { query: "Chicken Salad", includeImage: true }
  },
  {
    name: "Image look like",
    message: "what does the burger look like?",
    expectedTool: "search_menu_items",
    expectedArguments: { query: "burger", includeImage: true }
  },
  {
    name: "Contextual image",
    message: "any pic of it?",
    history: [
      { role: "user", content: "Tell me about Chicken Salad." },
      { role: "assistant", content: "Chicken Salad is a fresh salad with grilled chicken." }
    ],
    expectedTool: "search_menu_items",
    expectedArguments: { query: "Chicken Salad", includeImage: true }
  },
  {
    name: "Ambiguous image",
    message: "can I see it?",
    history: [
      { role: "assistant", content: "We have Jollof, Fried Rice, and Chicken Salad." }
    ],
    expectNoTool: true,
    forbiddenTools: ["search_menu_items"],
    expectedTextPattern: /which|what item|which one/i
  },
  { name: "Order start", message: "I want to order", expectedTool: "start_order" },
  {
    name: "Item without quantity",
    message: "I want assorted fried rice",
    expectedTool: "add_order_item_by_name",
    expectedArguments: { itemName: "assorted fried rice" },
    forbiddenArguments: ["quantity"],
    allowNoTool: true
  },
  {
    name: "Item with quantity",
    message: "2 assorted fried rice",
    expectedTool: "add_order_item_by_name",
    expectedArguments: { itemName: "assorted fried rice", quantity: 2 }
  },
  {
    name: "Informal order",
    message: "gimme 2 jollof",
    expectedTool: "add_order_item_by_name",
    expectedArguments: { itemName: "jollof", quantity: 2 }
  },
  {
    name: "Quantity follow-up",
    message: "3",
    activeDraft: draft({
      pendingMenuItemId: "64b000000000000000000302",
      pendingMenuItemName: "Assorted Fried Rice",
      currentStep: "collecting_quantity"
    }),
    expectedTool: "add_order_item_by_name",
    expectedArguments: { itemName: "Assorted Fried Rice", quantity: 3 }
  },
  {
    name: "Pickup",
    message: "I'll pick it up",
    activeDraft: chickenDraft,
    expectedTool: "update_order_draft",
    expectedArguments: { orderType: "pickup" }
  },
  {
    name: "Delivery",
    message: "bring it to me",
    activeDraft: chickenDraft,
    expectedTool: "update_order_draft",
    expectedArguments: { orderType: "delivery" }
  },
  {
    name: "Delivery address",
    message: "deliver to 12 Oxford Street, Osu",
    activeDraft: draft({ ...chickenDraft, orderType: "delivery", currentStep: "collecting_address" }),
    expectedTool: "update_order_draft",
    expectedArguments: { deliveryAddress: "12 Oxford Street, Osu" }
  },
  {
    name: "Customer name",
    message: "My name is Ruth",
    activeDraft: draft({ ...chickenDraft, customerName: undefined }),
    expectedTool: "update_order_draft",
    expectedArguments: { customerName: "Ruth" }
  },
  {
    name: "Confirmation",
    message: "yeah place the order",
    activeDraft: completeDraft,
    expectedTool: "confirm_order_draft"
  },
  {
    name: "Order status",
    message: "where's my order?",
    expectedOneOfTools: ["get_latest_customer_order", "get_order_details"]
  },
  {
    name: "Show my order is not menu media",
    message: "show me my order",
    expectedOneOfTools: ["get_order_draft", "get_latest_customer_order"],
    forbiddenTools: ["search_menu_items"]
  },
  {
    name: "Cancel submitted order",
    message: "cancel my order",
    expectedOneOfTools: ["get_latest_customer_order", "cancel_order"],
    forbiddenTools: ["cancel_order_draft"]
  },
  {
    name: "Cancel draft",
    message: "clear this draft",
    activeDraft: chickenDraft,
    expectedTool: "cancel_order_draft"
  },
  {
    name: "Remove item",
    message: "remove Chicken Salad",
    activeDraft: chickenDraft,
    expectedTool: "remove_order_item_by_name",
    expectedArguments: { itemName: "Chicken Salad" }
  },
  {
    name: "Update quantity",
    message: "make the Chicken Salad 5 instead",
    activeDraft: chickenDraft,
    expectedTool: "update_order_item_quantity",
    expectedArguments: { itemName: "Chicken Salad", newQuantity: 5 }
  },
  {
    name: "Read draft",
    message: "what's in my cart?",
    activeDraft: chickenDraft,
    expectedTool: "get_order_draft"
  },
  {
    name: "Recommendations",
    message: "what do you recommend?",
    expectedTool: "get_customer_recommendations"
  },
  {
    name: "Opening hours",
    message: "when do you close?",
    expectedTool: "get_restaurant_profile"
  },
  {
    name: "Delivery rules",
    message: "do you deliver to Osu?",
    expectedTool: "get_delivery_information"
  },
  {
    name: "Thanks",
    message: "thanks",
    expectNoTool: true,
    forbiddenTools: customerMutations
  },
  {
    name: "Conversational clarification",
    message: "what do you mean?",
    history: [{ role: "assistant", content: "Which order type would you prefer?" }],
    expectNoTool: true,
    forbiddenTools: customerMutations
  },
  {
    name: "Ambiguous menu match clarification",
    message: "Chicken Salad",
    activeClarification: {
      intent: "add_order_item",
      originalText: "chicken",
      candidates: [
        { menuItemId: "menu-1", name: "Chicken Salad", price: 35, available: true },
        { menuItemId: "menu-2", name: "Chicken Burger", price: 42, available: true }
      ]
    },
    expectedTool: "add_order_item_by_name",
    expectedArguments: { itemName: "Chicken Salad" },
    forbiddenArguments: ["quantity"]
  },
  {
    name: "Pending check-in does not hijack new order",
    message: "I want 2 fried rice",
    activeOrderCheckIns: [
      {
        orderNumber: "ORD-100",
        orderType: "delivery",
        status: "accepted",
        checkInStatus: "requested",
        awaitingComplaint: false,
        receiptClarificationPending: false
      }
    ],
    expectedTool: "add_order_item_by_name",
    expectedArguments: { itemName: "fried rice", quantity: 2 },
    forbiddenTools: ["respond_to_order_check_in"]
  },
  {
    name: "Natural satisfied check-in response",
    message: "yh I got it, food was nice",
    activeDraft: draft({
      cartItems: chickenDraft.cartItems,
      currentStep: "choosing_order_type"
    }),
    activeOrderCheckIns: [
      {
        orderNumber: "ORD-100",
        orderType: "delivery",
        status: "accepted",
        checkInStatus: "requested",
        awaitingComplaint: false,
        receiptClarificationPending: false
      }
    ],
    expectedTool: "respond_to_order_check_in",
    expectedArguments: { outcome: "received_satisfied" }
  },
  {
    name: "Natural complaint check-in response",
    message: "I got it but the chicken was cold",
    activeDraft: draft({
      cartItems: chickenDraft.cartItems,
      currentStep: "choosing_order_type"
    }),
    activeOrderCheckIns: [
      {
        orderNumber: "ORD-100",
        orderType: "pickup",
        status: "accepted",
        checkInStatus: "requested",
        awaitingComplaint: false,
        receiptClarificationPending: false
      }
    ],
    expectedTool: "respond_to_order_check_in",
    expectedArguments: { outcome: "received_complaint" }
  },
  {
    name: "Natural not-received check-in response",
    message: "I still haven't received it",
    activeDraft: draft({
      cartItems: chickenDraft.cartItems,
      currentStep: "choosing_order_type"
    }),
    activeOrderCheckIns: [
      {
        orderNumber: "ORD-100",
        orderType: "delivery",
        status: "accepted",
        checkInStatus: "requested",
        awaitingComplaint: false,
        receiptClarificationPending: false
      }
    ],
    expectedTool: "respond_to_order_check_in",
    expectedArguments: { outcome: "not_received" }
  },
  {
    name: "Multiple active check-ins require order clarification",
    message: "I got it and it was fine",
    activeOrderCheckIns: [
      {
        orderNumber: "ORD-100",
        orderType: "delivery",
        status: "accepted",
        checkInStatus: "requested",
        awaitingComplaint: false,
        receiptClarificationPending: false
      },
      {
        orderNumber: "ORD-101",
        orderType: "pickup",
        status: "accepted",
        checkInStatus: "requested",
        awaitingComplaint: false,
        receiptClarificationPending: false
      }
    ],
    expectNoTool: true,
    forbiddenTools: ["respond_to_order_check_in"],
    expectedTextPattern: /which order|order number|ORD-100|ORD-101/i
  },
  {
    name: "Marketing STOP boundary",
    message: "STOP",
    expectNoTool: true,
    forbiddenTools: customerMutations,
    deterministicBoundary: true
  },
  {
    name: "Marketing START boundary",
    message: "START",
    expectNoTool: true,
    forbiddenTools: customerMutations,
    deterministicBoundary: true
  }
];
