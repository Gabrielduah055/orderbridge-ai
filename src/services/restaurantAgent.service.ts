import {
  saveAgentConversationMessage
} from "./agentConversationHistory.service";
import {
  cancelPendingToolAction,
  executeAgentTool,
  executeConfirmedPendingToolAction,
  findLatestPendingToolAction,
  findPendingToolActions
} from "../agent-tools/tool.executor";
import { getAiProviderName, getOpenRouterConfig } from "./ai/ai.config";
import { runAgentOrchestrator } from "./ai/agentOrchestrator.service";
import { handleCustomerMessage } from "./agentCustomer.service";
import { isHermesAgentConfigured, sendHermesAgentMessage } from "./hermesAgent.service";
import { resolveSenderIdentity } from "./senderIdentity.service";
import type {
  RestaurantAgentMessageInput,
  RestaurantAgentResponse
} from "../types/agent.types";

const temporaryHermesErrorMessage =
  "I'm having trouble reaching the restaurant assistant right now. Please try again in a few minutes.";
const temporaryAgentErrorMessage =
  "I'm having trouble reaching the restaurant system right now. Please try again shortly.";

const normalizeText = (value: string): string => value.trim().replace(/\s+/g, " ");

interface AgentMenuItemView {
  name?: unknown;
  price?: unknown;
  available?: unknown;
}

interface AgentMenuCategoryView {
  name?: unknown;
  active?: unknown;
  items?: unknown;
}

const isMenuRequest = (message: string): boolean => {
  const normalized = message.toLowerCase();

  return (
    (/\b(menu|menus)\b/.test(normalized) &&
      /\b(show|list|see|view|display|send|what|today|available|have)\b/.test(normalized)) ||
    /\b(serve|serving|food|foods|dish|dishes)\b/.test(normalized)
  );
};

const normalizeDecisionText = (message: string): string => {
  return message
    .toLowerCase()
    .replace(/[^\w\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

export const isPendingActionConfirmationMessage = (message: string): boolean => {
  const normalized = normalizeDecisionText(message);

  return (
    /^(yes|yeah|yep|yup|yh|sure|correct|confirm|confirmed)\b/.test(normalized) ||
    /^(ok|okay|alright)\s+(go ahead|proceed|save|confirm|update|change|do it)\b/.test(normalized) ||
    /^(go ahead|proceed|save it|do it)\b/.test(normalized) ||
    /^(update|change)\s+(it|that|the item|the price|this)\b/.test(normalized)
  );
};

const parseOwnerOrderDecision = (
  message: string
): { decision: "accept" | "reject"; orderReference: string; reason?: string } | null => {
  const normalized = message.trim();
  const match = normalized.match(
    /^(?:accept|confirm(?:\s+order)?|reject|cancel)\s+(?:order\s+)?(ORD-[A-Za-z0-9-]+|[a-f0-9]{24})(?:\s+(.+))?$/i
  );

  if (!match) {
    return null;
  }

  const verb = normalized.split(/\s+/)[0].toLowerCase();

  return {
    decision: verb === "reject" || verb === "cancel" ? "reject" : "accept",
    orderReference: match[1],
    reason: match[2]?.trim()
  };
};

const formatPendingActionLabel = (toolName?: string, summary?: string): string => {
  if (summary) {
    return summary;
  }

  if (toolName === "confirm_order") {
    return "Accept an order";
  }

  if (toolName === "reject_order") {
    return "Reject an order";
  }

  return "Complete a pending action";
};

const buildAmbiguousPendingActionMessage = (
  actions: Awaited<ReturnType<typeof findPendingToolActions>>
): string => {
  const lines = actions.map(
    (action, index) =>
      `${index + 1}. ${formatPendingActionLabel(action.toolName, action.summary)}`
  );

  return [
    "I currently have more than one action awaiting confirmation:",
    "",
    ...lines,
    "",
    "Please reply with the specific order or action."
  ].join("\n");
};

export const isPendingActionCancellationMessage = (message: string): boolean => {
  const normalized = normalizeDecisionText(message);

  return (
    /^(no|nope|nah)\b/.test(normalized) ||
    /^(cancel|stop|abort)\b/.test(normalized) ||
    /^(don't|dont)\s+(save|update|change|do it|proceed)\b/.test(normalized) ||
    /^(never mind|nevermind|not now|leave it|ignore it)\b/.test(normalized)
  );
};

const formatPrice = (price: unknown): string => {
  return typeof price === "number" && Number.isFinite(price) ? `GHS ${price}` : "Price not set";
};

export const shouldUseOpenRouterCustomerAgent = (
  aiProviderName: string,
  customerAgentEnabled: boolean
): boolean => aiProviderName === "openrouter" && customerAgentEnabled;

const formatMenuResponse = (restaurantName: string, data: unknown): string => {
  const categories = Array.isArray(data) ? (data as AgentMenuCategoryView[]) : [];
  const sections = categories
    .map((category) => {
      const categoryName = typeof category.name === "string" ? category.name : "Menu";
      const categoryStatus = category.active === false ? " (inactive)" : "";
      const items = Array.isArray(category.items) ? (category.items as AgentMenuItemView[]) : [];
      const itemLines = items
        .map((item) => {
          const itemName = typeof item.name === "string" ? item.name : null;

          if (!itemName) {
            return null;
          }

          const availability = item.available === false ? " (unavailable)" : "";

          return `- ${itemName} - ${formatPrice(item.price)}${availability}`;
        })
        .filter((line): line is string => Boolean(line));

      if (itemLines.length === 0) {
        return null;
      }

      return [`*${categoryName}${categoryStatus}*`, ...itemLines].join("\n");
    })
    .filter((section): section is string => Boolean(section));

  if (sections.length === 0) {
    return `I couldn't find any menu items saved for ${restaurantName} yet.`;
  }

  return [`Here is the current menu for ${restaurantName}:`, ...sections].join("\n\n");
};

const handleLocalMenuRequest = async (
  input: RestaurantAgentMessageInput,
  sender: ReturnType<typeof resolveSenderIdentity>
): Promise<RestaurantAgentResponse> => {
  const restaurantId = String(input.restaurant._id);
  const result = await executeAgentTool(
    "get_menu",
    {
      availableOnly: sender.role === "customer"
    },
    {
      restaurantId,
      restaurant: input.restaurant,
      sender
    }
  );
  const message = result.success
    ? formatMenuResponse(input.restaurant.name, result.data)
    : result.message;

  await saveAgentConversationMessage({
    restaurantId,
    senderPhone: sender.normalizedPhone,
    senderRole: sender.role,
    direction: "assistant",
    content: message,
    metadata: {
      source: "hermes_tools",
      toolName: "get_menu",
      success: result.success,
      code: result.code
    }
  });

  return {
    success: result.success,
    message,
    data: result.data && typeof result.data === "object" ? { menu: result.data } : undefined,
    source: "hermes_tools",
    sender
  };
};

const handleLocalCustomerRequest = async (
  input: RestaurantAgentMessageInput,
  sender: ReturnType<typeof resolveSenderIdentity>
): Promise<RestaurantAgentResponse> => {
  const restaurantId = String(input.restaurant._id);
  const result = await handleCustomerMessage({
    restaurantId,
    customerPhone: sender.normalizedPhone,
    customerName: sender.name,
    message: input.message
  });

  await saveAgentConversationMessage({
    restaurantId,
    senderPhone: sender.normalizedPhone,
    senderRole: sender.role,
    direction: "assistant",
    content: result.message,
    metadata: {
      source: "legacy_customer",
      success: result.success
    }
  });

  return {
    success: result.success,
    message: result.message,
    data: result.data,
    source: "legacy_customer",
    sender
  };
};

export const handleRestaurantAgentMessage = async (
  input: RestaurantAgentMessageInput
): Promise<RestaurantAgentResponse> => {
  const restaurantId = String(input.restaurant._id);
  const sender = resolveSenderIdentity(input.restaurant, input.senderPhone);
  const message = normalizeText(input.message);
  const aiProviderName = getAiProviderName();
  const openRouterConfig = getOpenRouterConfig();
  const customerOpenRouterEnabled = shouldUseOpenRouterCustomerAgent(
    aiProviderName,
    openRouterConfig.customerAgentEnabled
  );

  console.info("Restaurant agent sender resolved", {
    restaurantId,
    senderRole: sender.role,
    verified: sender.verified
  });

  await saveAgentConversationMessage({
    restaurantId,
    senderPhone: sender.normalizedPhone,
    senderRole: sender.role,
    direction: "user",
    content: message,
    metadata: {
      source: aiProviderName === "openrouter" ? "openrouter_agent" : "hermes_agent"
    }
  });

  if (
    isMenuRequest(message) &&
    ((sender.role === "customer" && !customerOpenRouterEnabled) || aiProviderName !== "openrouter")
  ) {
    return handleLocalMenuRequest(input, sender);
  }

  if (sender.role === "customer") {
    if (customerOpenRouterEnabled) {
      const agentResult = await runAgentOrchestrator({
        restaurant: input.restaurant,
        sender,
        message
      });

      await saveAgentConversationMessage({
        restaurantId,
        senderPhone: sender.normalizedPhone,
        senderRole: sender.role,
        direction: "assistant",
        content: agentResult.message,
        metadata: {
          source: "openrouter_agent",
          provider: agentResult.provider,
          model: agentResult.model,
          responseId: agentResult.responseId,
          success: agentResult.success,
          customerAgentEnabled: true,
          legacyFallbackEnabled: openRouterConfig.customerLegacyFallback,
          executedTools: agentResult.executedTools,
          usage: agentResult.usage
        }
      });

      console.info("Customer OpenRouter agent completed", {
        restaurantId,
        senderRole: sender.role,
        provider: agentResult.provider,
        model: agentResult.model,
        customerAgentEnabled: true,
        legacyFallbackEnabled: openRouterConfig.customerLegacyFallback,
        toolNames: agentResult.executedTools.map((tool) => tool.name),
        success: agentResult.success,
        totalTokens: agentResult.usage?.totalTokens
      });

      if (!agentResult.success && openRouterConfig.customerLegacyFallback) {
        console.warn("Customer OpenRouter agent failed; using explicit legacy fallback", {
          restaurantId,
          senderRole: sender.role
        });

        return handleLocalCustomerRequest(input, sender);
      }

      return {
        success: agentResult.success,
        message: agentResult.message || temporaryAgentErrorMessage,
        data: agentResult.data,
        source: "openrouter_agent",
        sender
      };
    }

    return handleLocalCustomerRequest(input, sender);
  }

  const executionContext = {
    restaurantId,
    restaurant: input.restaurant,
    sender
  };
  const ownerOrderDecision =
    sender.role === "owner" || sender.role === "manager"
      ? parseOwnerOrderDecision(message)
      : null;

  if (ownerOrderDecision) {
    const result = await executeAgentTool(
      ownerOrderDecision.decision === "accept" ? "confirm_order" : "reject_order",
      {
        orderReference: ownerOrderDecision.orderReference,
        reason: ownerOrderDecision.reason
      },
      executionContext
    );

    await saveAgentConversationMessage({
      restaurantId,
      senderPhone: sender.normalizedPhone,
      senderRole: sender.role,
      direction: "assistant",
      content: result.message,
      metadata: {
        source: "deterministic_owner_order_decision",
        success: result.success,
        code: result.code
      }
    });

    return {
      success: result.success,
      message: result.message,
      data: result.data && typeof result.data === "object" ? { ...result.data } : undefined,
      source: aiProviderName === "openrouter" ? "openrouter_agent" : "hermes_tools",
      sender
    };
  }

  const pendingAction =
    aiProviderName === "openrouter"
      ? await findLatestPendingToolAction(executionContext)
      : null;

  if (
    aiProviderName === "openrouter" &&
    pendingAction &&
    isPendingActionConfirmationMessage(message)
  ) {
    const pendingActions = await findPendingToolActions(executionContext);

    if (pendingActions.length > 1) {
      const clarificationMessage = buildAmbiguousPendingActionMessage(pendingActions);

      await saveAgentConversationMessage({
        restaurantId,
        senderPhone: sender.normalizedPhone,
        senderRole: sender.role,
        direction: "assistant",
        content: clarificationMessage,
        metadata: {
          source: "openrouter_agent",
          deterministicAction: "ambiguous_pending_action",
          pendingActionCount: pendingActions.length
        }
      });

      return {
        success: false,
        message: clarificationMessage,
        source: "openrouter_agent",
        sender
      };
    }

    const result = await executeConfirmedPendingToolAction(
      String(pendingAction._id),
      executionContext
    );

    await saveAgentConversationMessage({
      restaurantId,
      senderPhone: sender.normalizedPhone,
      senderRole: sender.role,
      direction: "assistant",
      content: result.message,
      metadata: {
        source: "openrouter_agent",
        deterministicAction: "confirm_pending_action",
        success: result.success,
        code: result.code
      }
    });

    return {
      success: result.success,
      message: result.message,
      data: result.data && typeof result.data === "object" ? { ...result.data } : undefined,
      source: "openrouter_agent",
      sender
    };
  }

  if (
    aiProviderName === "openrouter" &&
    pendingAction &&
    isPendingActionCancellationMessage(message)
  ) {
    const result = await cancelPendingToolAction(executionContext);

    await saveAgentConversationMessage({
      restaurantId,
      senderPhone: sender.normalizedPhone,
      senderRole: sender.role,
      direction: "assistant",
      content: result.message,
      metadata: {
        source: "openrouter_agent",
        deterministicAction: "cancel_pending_action",
        success: result.success,
        code: result.code
      }
    });

    return {
      success: result.success,
      message: result.message,
      data: result.data && typeof result.data === "object" ? { ...result.data } : undefined,
      source: "openrouter_agent",
      sender
    };
  }

  if (aiProviderName === "openrouter") {
    const agentResult = await runAgentOrchestrator({
      restaurant: input.restaurant,
      sender,
      message
    });

    await saveAgentConversationMessage({
      restaurantId,
      senderPhone: sender.normalizedPhone,
      senderRole: sender.role,
      direction: "assistant",
      content: agentResult.message,
      metadata: {
        source: "openrouter_agent",
        provider: agentResult.provider,
        model: agentResult.model,
        responseId: agentResult.responseId,
        success: agentResult.success,
        executedTools: agentResult.executedTools,
        usage: agentResult.usage
      }
    });

    return {
      success: agentResult.success,
      message: agentResult.message || temporaryAgentErrorMessage,
      data: agentResult.data,
      source: "openrouter_agent",
      sender
    };
  }

  if (!isHermesAgentConfigured()) {
    console.error("Hermes agent is not configured", {
      restaurantId,
      senderRole: sender.role
    });

    await saveAgentConversationMessage({
      restaurantId,
      senderPhone: sender.normalizedPhone,
      senderRole: sender.role,
      direction: "assistant",
      content: temporaryHermesErrorMessage,
      metadata: {
        source: "hermes_agent",
        error: "not_configured"
      }
    });

    return {
      success: false,
      message: temporaryHermesErrorMessage,
      source: "hermes_agent",
      sender
    };
  }

  const hermesAgentResult = await sendHermesAgentMessage(input.restaurant, sender, message);

  if (!hermesAgentResult) {
    await saveAgentConversationMessage({
      restaurantId,
      senderPhone: sender.normalizedPhone,
      senderRole: sender.role,
      direction: "assistant",
      content: temporaryHermesErrorMessage,
      metadata: {
        source: "hermes_agent",
        error: "unavailable"
      }
    });

    return {
      success: false,
      message: temporaryHermesErrorMessage,
      source: "hermes_agent",
      sender
    };
  }

  await saveAgentConversationMessage({
    restaurantId,
    senderPhone: sender.normalizedPhone,
    senderRole: sender.role,
    direction: "assistant",
    content: hermesAgentResult.message,
    metadata: {
      source: "hermes_agent",
      responseId: hermesAgentResult.responseId
    }
  });

  return {
    success: true,
    message: hermesAgentResult.message,
    data: hermesAgentResult.data,
    source: "hermes_agent",
    sender
  };
};
