import dotenv from "dotenv";
import type { ICustomerSessionDocument } from "../models/customerSession.model";
import type { IRestaurantDocument } from "../models/Restaurant";
import type { RestaurantAgentContext, ResolvedSender } from "../types/agent.types";
import { getAllowedToolNamesForRole } from "../agent-tools/tool.permissions";
import { buildAgentSystemPrompt } from "../services/ai/agentPrompt.service";
import { getAgentToolDefinitionsForRole } from "../services/ai/agentToolDefinitions.service";
import { getOpenRouterConfig } from "../services/ai/ai.config";
import { OpenRouterProvider } from "../services/ai/providers/openRouter.provider";
import {
  formatCustomerAgentEvaluation,
  runCustomerAgentEvaluation
} from "./customerAgent.evaluator";
import {
  customerAgentScenarios,
  type CustomerAgentEvalScenario,
  type SyntheticCustomerDraft
} from "./customerAgent.scenarios";

dotenv.config();

const restaurant = {
  _id: "64b000000000000000000888",
  name: "Golden Grill Customer Eval",
  ownerName: "Eval Owner",
  ownerPhone: "+233500000001",
  managerPhones: [],
  managerContacts: [],
  status: "active",
  timezone: "Africa/Accra",
  primaryCuisine: "Ghanaian",
  location: "Accra",
  deliveryEnabled: true,
  allowTakeaway: true
} as unknown as IRestaurantDocument;

const sender: ResolvedSender = {
  name: "Ruth",
  phone: "+233500000099",
  normalizedPhone: "+233500000099",
  role: "customer",
  verified: false
};

const buildSyntheticRestaurantContext = async (
  _restaurant: IRestaurantDocument,
  currentSender: ResolvedSender,
  permissions: string[]
): Promise<RestaurantAgentContext> => ({
  restaurant: {
    id: String(restaurant._id),
    name: restaurant.name,
    cuisine: "Ghanaian",
    location: "Accra",
    status: restaurant.status
  },
  sender: {
    name: currentSender.name,
    phone: currentSender.phone,
    role: currentSender.role,
    verified: currentSender.verified
  },
  people: { ownerName: restaurant.ownerName },
  settings: {
    deliveryEnabled: true,
    takeawayEnabled: true,
    assistantTone: "friendly"
  },
  summary: {
    activeCategories: 3,
    activeMenuItems: 12,
    unavailableMenuItems: 1,
    activeOrders: 1
  },
  permissions
});

const buildSyntheticDraft = (
  value: SyntheticCustomerDraft
): ICustomerSessionDocument =>
  ({
    _id: "64b000000000000000000889",
    restaurantId: restaurant._id,
    customerPhone: sender.normalizedPhone,
    customerName: value.customerName,
    cartItems: value.cartItems ?? [],
    pendingMenuItemId: value.pendingMenuItemId,
    pendingMenuItemName: value.pendingMenuItemName,
    currentStep: value.currentStep ?? "idle",
    orderType: value.orderType ?? null,
    deliveryAddress: value.deliveryAddress,
    deliveryFee: value.deliveryFee,
    deliveryFeeSource: value.deliveryFeeSource,
    deliveryFeeResolved: value.deliveryFeeResolved ?? false
  }) as unknown as ICustomerSessionDocument;

export const buildLiveCustomerEvalSystemPrompt = async (
  scenario: CustomerAgentEvalScenario
): Promise<string> =>
  buildAgentSystemPrompt(
    restaurant,
    sender,
    getAllowedToolNamesForRole("customer"),
    {
      buildRestaurantContext: buildSyntheticRestaurantContext,
      findDraft: async () =>
        scenario.activeDraft ? buildSyntheticDraft(scenario.activeDraft) : null,
      findClarification: async () =>
        (scenario.activeClarification ?? null) as never,
      loadCustomerMemory: async () => ({
        name: "Ruth",
        completedOrderCount: 4,
        frequentItems: ["Jollof Rice"],
        preferredOrderType: "pickup",
        marketingConsent: "granted"
      })
    }
  );

const run = async (): Promise<void> => {
  const config = getOpenRouterConfig();

  if (!config.apiKey || !config.model) {
    console.log("LIVE CUSTOMER EVAL SKIPPED — AI credentials not configured");
    return;
  }

  const provider = new OpenRouterProvider();
  const result = await runCustomerAgentEvaluation(
    customerAgentScenarios,
    async (scenario) => {
      if (scenario.deterministicBoundary) {
        return {
          text: "Handled by the deterministic marketing preference boundary.",
          toolCalls: []
        };
      }

      const systemPrompt = await buildLiveCustomerEvalSystemPrompt(scenario);

      return provider.complete({
        messages: [
          { role: "system", content: systemPrompt },
          ...(scenario.history ?? []),
          { role: "user", content: scenario.message }
        ],
        tools: getAgentToolDefinitionsForRole("customer"),
        toolChoice: "auto"
      });
    }
  );

  console.log(formatCustomerAgentEvaluation(result));

  if (result.failed > 0) {
    process.exitCode = 1;
  }
};

if (require.main === module) {
  void run().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "Unknown live evaluation error";
    console.error(`LIVE CUSTOMER EVAL FAILED — ${message}`);
    process.exitCode = 1;
  });
}
