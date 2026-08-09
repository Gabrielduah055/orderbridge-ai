import dotenv from "dotenv";
import type { IRestaurantDocument } from "../models/Restaurant";
import type { RestaurantAgentContext, ResolvedSender } from "../types/agent.types";
import { getAllowedToolNamesForRole } from "../agent-tools/tool.permissions";
import { buildAgentSystemPrompt } from "../services/ai/agentPrompt.service";
import { getAgentToolDefinitionsForRole } from "../services/ai/agentToolDefinitions.service";
import { getOpenRouterConfig } from "../services/ai/ai.config";
import { OpenRouterProvider } from "../services/ai/providers/openRouter.provider";
import { createEmptyStaffOperationalState } from "../services/ai/staffOperationalState.service";
import {
  formatStaffAgentEvaluation,
  runStaffAgentEvaluation
} from "./staffAgent.evaluator";
import { staffAgentScenarios } from "./staffAgent.scenarios";

dotenv.config();

const restaurant = {
  _id: "64b000000000000000000777",
  name: "Golden Grill Eval",
  ownerName: "Eval Owner",
  ownerPhone: "+233500000001",
  managerPhones: ["+233500000002"],
  managerContacts: [],
  status: "active",
  timezone: "Africa/Accra",
  cuisine: "Ghanaian",
  location: "Accra",
  deliveryEnabled: true,
  allowTakeaway: true
} as unknown as IRestaurantDocument;

const buildSyntheticRestaurantContext = async (
  _restaurant: IRestaurantDocument,
  sender: ResolvedSender,
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
    name: sender.name,
    phone: sender.phone,
    role: sender.role,
    verified: sender.verified
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
    activeOrders: 2
  },
  permissions
});

const buildSyntheticSender = (
  role: "owner" | "manager"
): ResolvedSender => ({
  name: role === "owner" ? "Eval Owner" : "Eval Manager",
  phone: role === "owner" ? "+233500000001" : "+233500000002",
  normalizedPhone: role === "owner" ? "+233500000001" : "+233500000002",
  role,
  verified: true
});

export const buildLiveStaffEvalSystemPrompt = async (
  scenario: (typeof staffAgentScenarios)[number]
): Promise<string> => {
  const sender = buildSyntheticSender(scenario.role);
  const permissions = getAllowedToolNamesForRole(scenario.role);
  const staffState =
    scenario.staffState ?? createEmptyStaffOperationalState(scenario.role);

  return buildAgentSystemPrompt(
    restaurant,
    sender,
    permissions,
    { buildRestaurantContext: buildSyntheticRestaurantContext },
    staffState
  );
};

const run = async (): Promise<void> => {
  const config = getOpenRouterConfig();

  if (!config.apiKey || !config.model) {
    console.log("LIVE STAFF EVAL SKIPPED — AI credentials not configured");
    return;
  }

  const provider = new OpenRouterProvider();
  const result = await runStaffAgentEvaluation(staffAgentScenarios, async (scenario) => {
    const systemPrompt = await buildLiveStaffEvalSystemPrompt(scenario);

    return provider.complete({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: scenario.message }
      ],
      tools: getAgentToolDefinitionsForRole(scenario.role),
      toolChoice: "auto"
    });
  });

  console.log(formatStaffAgentEvaluation(result));

  if (result.failed > 0) {
    process.exitCode = 1;
  }
};

if (require.main === module) {
  void run().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown live evaluation error";
    console.error(`LIVE STAFF EVAL FAILED — ${message}`);
    process.exitCode = 1;
  });
}
