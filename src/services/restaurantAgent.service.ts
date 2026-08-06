import {
  saveAgentConversationMessage
} from "./agentConversationHistory.service";
import { cancelPendingOrderItemClarifications } from "./agentClarification.service";
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
import { PendingAgentAction } from "../models/pendingAgentAction.model";
import {
  handleSavedOwnerSelectionReply,
  handleUnquotedOwnerOrderDecision,
  parseSimpleOwnerDecision,
  resolveQuotedOwnerOrderDecision
} from "./ownerOrderResolution.service";
import { resolveSenderIdentity } from "./senderIdentity.service";
import {
  attachPendingImageToNamedMenuItem,
  rememberMenuItemImageRequest
} from "./menuItemImageWorkflow.service";
import { handleCustomerMarketingPreferenceCommand } from "./customerMarketingPreference.service";
import { handleOrderFeedbackCustomerResponse } from "./orderFeedback.service";
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
  imageUrl?: unknown;
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

export const parseSpecificMenuItemViewRequest = (message: string): string | null => {
  const normalized = normalizeText(message);
  const patterns = [
    /^(?:please\s+)?(?:show|send)(?:\s+me)?(?:\s+(?:a|the))?(?:\s+(?:photo|image|picture))?(?:\s+of)?\s+(.+)$/i,
    /^(?:please\s+)?(?:view|see)(?:\s+(?:a|the))?(?:\s+(?:photo|image|picture))?(?:\s+of)?\s+(.+)$/i,
    /^(?:photo|image|picture)\s+(?:of|for)\s+(.+)$/i,
    /^what\s+does\s+(.+?)\s+look\s+like\??$/i
  ];

  for (const pattern of patterns) {
    const candidate = normalized.match(pattern)?.[1]?.trim().replace(/[.?!]+$/, "");

    if (candidate && !/^(?:the\s+)?menus?$/i.test(candidate)) {
      return candidate;
    }
  }

  return null;
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
    /^\d+$/.test(normalized) ||
    /^(yes|yeah|ok|okay)\s+\d+$/.test(normalized) ||
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
      sender,
      originalMessage: input.message
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

const handleSpecificMenuItemViewRequest = async (
  input: RestaurantAgentMessageInput,
  sender: ReturnType<typeof resolveSenderIdentity>,
  itemName: string
): Promise<RestaurantAgentResponse> => {
  const restaurantId = String(input.restaurant._id);
  const result = await executeAgentTool(
    "search_menu_items",
    {
      query: itemName,
      availableOnly: true
    },
    {
      restaurantId,
      restaurant: input.restaurant,
      sender,
      originalMessage: input.message
    }
  );
  const matches = Array.isArray(result.data) ? (result.data as AgentMenuItemView[]) : [];
  const onlyItem = matches.length === 1 ? matches[0] : undefined;
  const resolvedName = typeof onlyItem?.name === "string" ? onlyItem.name : itemName;
  const imageUrl = typeof onlyItem?.imageUrl === "string" ? onlyItem.imageUrl : undefined;
  const message = !result.success
    ? result.message
    : matches.length === 0
      ? `I couldn't find ${itemName} on the current menu.`
      : matches.length > 1
        ? `I found several matching meals: ${matches
            .map((item) => item.name)
            .filter((name): name is string => typeof name === "string")
            .join(", ")}. Which one would you like to view?`
        : imageUrl
          ? `Here is ${resolvedName}.`
          : `I found ${resolvedName}, but it doesn't have a saved image yet.`;
  const response: RestaurantAgentResponse = {
    success: result.success,
    message,
    data: imageUrl ? { imageUrl, imageItemName: resolvedName } : undefined,
    source: "hermes_tools",
    sender
  };

  await saveAssistantResponse(restaurantId, sender, response, {
    source: "deterministic_menu_item_image_view",
    toolName: "search_menu_items",
    success: result.success,
    matchCount: matches.length
  });

  return response;
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


const saveAssistantResponse = async (
  restaurantId: string,
  sender: ReturnType<typeof resolveSenderIdentity>,
  response: RestaurantAgentResponse,
  metadata: Record<string, unknown>
): Promise<void> => {
  await saveAgentConversationMessage({
    restaurantId,
    senderPhone: sender.normalizedPhone,
    senderRole: sender.role,
    direction: "assistant",
    content: response.message,
    metadata
  });
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

  if (sender.role === "customer") {
    const preferenceResult =
      await handleCustomerMarketingPreferenceCommand(
        restaurantId,
        sender.normalizedPhone,
        message
      );

    if (preferenceResult.handled && preferenceResult.message) {
      await saveAgentConversationMessage({
        restaurantId,
        senderPhone: sender.normalizedPhone,
        senderRole: sender.role,
        direction: "user",
        content: message,
        metadata: {
          source: "deterministic_marketing_preference",
          command: preferenceResult.command
        }
      });
      await saveAgentConversationMessage({
        restaurantId,
        senderPhone: sender.normalizedPhone,
        senderRole: sender.role,
        direction: "assistant",
        content: preferenceResult.message,
        metadata: {
          source: "deterministic_marketing_preference",
          command: preferenceResult.command
        }
      });

      return {
        success: true,
        message: preferenceResult.message,
        data: {
          marketingPreference: preferenceResult.command
        },
        source: "legacy_customer",
        sender
      };
    }

    const feedbackResult = await handleOrderFeedbackCustomerResponse({
      restaurantId,
      customerPhone: sender.normalizedPhone,
      customerName: sender.name,
      message,
      inboundEventId: input.inboundEventId
    });

    if (feedbackResult.handled && feedbackResult.message) {
      await saveAgentConversationMessage({
        restaurantId,
        senderPhone: sender.normalizedPhone,
        senderRole: sender.role,
        direction: "user",
        content: message,
        metadata: {
          source: "deterministic_order_feedback",
          inboundEventId: input.inboundEventId
        }
      });
      await saveAgentConversationMessage({
        restaurantId,
        senderPhone: sender.normalizedPhone,
        senderRole: sender.role,
        direction: "assistant",
        content: feedbackResult.message,
        metadata: {
          source: "deterministic_order_feedback",
          success: feedbackResult.success,
          orderId: feedbackResult.order
            ? String(feedbackResult.order._id)
            : undefined,
          feedbackId: feedbackResult.feedback
            ? String(feedbackResult.feedback._id)
            : undefined
        }
      });

      return {
        success: feedbackResult.success,
        message: feedbackResult.message,
        data: {
          order: feedbackResult.order,
          feedback: feedbackResult.feedback,
          ambiguousOrderNumbers: feedbackResult.ambiguousOrderNumbers
        },
        source: "legacy_customer",
        sender
      };
    }

  }

  // For the customer OpenRouter orchestrator path we defer the user-message save until
  // AFTER the orchestrator returns.  If we save it now it appears at the end of the
  // history window that the orchestrator fetches, which (a) wastes a context slot and
  // (b) can cause the orchestrator to push the same message a second time, confusing
  // the AI about what was already said.
  const deferUserMessageSave = sender.role === "customer" && customerOpenRouterEnabled;

  if (!deferUserMessageSave) {
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
  }

  if (sender.role === "customer") {
    const specificItemName = parseSpecificMenuItemViewRequest(message);

    if (specificItemName) {
      if (deferUserMessageSave) {
        await saveAgentConversationMessage({
          restaurantId,
          senderPhone: sender.normalizedPhone,
          senderRole: sender.role,
          direction: "user",
          content: message,
          metadata: { source: "deterministic_menu_item_image_view" }
        });
      }

      return handleSpecificMenuItemViewRequest(input, sender, specificItemName);
    }
  }

  if (
    isMenuRequest(message) &&
    ((sender.role === "customer" && !customerOpenRouterEnabled) || aiProviderName !== "openrouter")
  ) {
    return handleLocalMenuRequest(input, sender);
  }

  if (sender.role === "customer") {
    if (customerOpenRouterEnabled) {
      // ── Stale-clarification guard ──────────────────────────────────────────
      // If the customer sends a greeting or asks for the menu, they have clearly
      // started a new conversation.  Cancel any pending clarification that was
      // left over from the previous session so the AI starts with a clean slate
      // and does not keep asking them to choose between items they no longer
      // care about.  For all other messages the AI receives the active
      // clarification in its system-prompt context and can reason about it.
      const isGreeting = /^(hi|hello|hey|good\s+(morning|afternoon|evening)|start)\b/i.test(message);

      if (isGreeting || isMenuRequest(message)) {
        await cancelPendingOrderItemClarifications({
          restaurantId,
          senderPhone: sender.normalizedPhone
        });
      }

      const agentResult = await runAgentOrchestrator({
        restaurant: input.restaurant,
        sender,
        message
      });

      // Now that the orchestrator has run and built its context from the uncontaminated
      // history window, persist the user message followed by the assistant response.
      await saveAgentConversationMessage({
        restaurantId,
        senderPhone: sender.normalizedPhone,
        senderRole: sender.role,
        direction: "user",
        content: message,
        metadata: { source: "openrouter_agent" }
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
    sender,
    originalMessage: message,
    quotedMessageId: input.quotedMessageId
  };

  if (sender.role === "owner" || sender.role === "manager") {
    const pendingImageConfirmation = await PendingAgentAction.findOne({
      restaurantId,
      senderPhone: sender.normalizedPhone,
      action: "TOOL_CALL",
      toolName: "set_menu_item_image",
      status: "pending",
      expiresAt: { $gt: new Date() }
    }).sort({ createdAt: -1 });

    if (pendingImageConfirmation && isPendingActionConfirmationMessage(message)) {
      const result = await executeConfirmedPendingToolAction(
        String(pendingImageConfirmation._id),
        executionContext
      );

      await saveAssistantResponse(
        restaurantId,
        sender,
        {
          success: result.success,
          message: result.message,
          data: result.data && typeof result.data === "object" ? { ...result.data } : undefined,
          source: aiProviderName === "openrouter" ? "openrouter_agent" : "hermes_tools",
          sender
        },
        {
          source: "deterministic_menu_item_image_confirmation",
          success: result.success,
          code: result.code
        }
      );

      return {
        success: result.success,
        message: result.message,
        data: result.data && typeof result.data === "object" ? { ...result.data } : undefined,
        source: aiProviderName === "openrouter" ? "openrouter_agent" : "hermes_tools",
        sender
      };
    }

    if (pendingImageConfirmation && isPendingActionCancellationMessage(message)) {
      const result = await cancelPendingToolAction(executionContext);

      await saveAssistantResponse(
        restaurantId,
        sender,
        {
          success: result.success,
          message: result.message,
          source: aiProviderName === "openrouter" ? "openrouter_agent" : "hermes_tools",
          sender
        },
        {
          source: "deterministic_menu_item_image_cancellation",
          success: result.success,
          code: result.code
        }
      );

      return {
        success: result.success,
        message: result.message,
        source: aiProviderName === "openrouter" ? "openrouter_agent" : "hermes_tools",
        sender
      };
    }

    const pendingImageItemResult = await attachPendingImageToNamedMenuItem({
      restaurantId,
      senderPhone: sender.normalizedPhone,
      senderRole: sender.role,
      message
    });

    if (pendingImageItemResult.handled) {
      await saveAssistantResponse(
        restaurantId,
        sender,
        {
          success: pendingImageItemResult.success,
          message: pendingImageItemResult.message,
          source: aiProviderName === "openrouter" ? "openrouter_agent" : "hermes_tools",
          sender
        },
        {
          source: "deterministic_menu_item_image_item_selection",
          success: pendingImageItemResult.success,
          itemName: pendingImageItemResult.itemName
        }
      );

      return {
        success: pendingImageItemResult.success,
        message: pendingImageItemResult.message,
        source: aiProviderName === "openrouter" ? "openrouter_agent" : "hermes_tools",
        sender
      };
    }

    const imageRequestResult = await rememberMenuItemImageRequest({
      restaurantId,
      senderPhone: sender.normalizedPhone,
      senderRole: sender.role,
      message
    });

    if (imageRequestResult.handled) {
      await saveAssistantResponse(
        restaurantId,
        sender,
        {
          success: imageRequestResult.success,
          message: imageRequestResult.message,
          source: aiProviderName === "openrouter" ? "openrouter_agent" : "hermes_tools",
          sender
        },
        {
          source: "deterministic_menu_item_image_context",
          success: imageRequestResult.success,
          itemName: imageRequestResult.itemName
        }
      );

      return {
        success: imageRequestResult.success,
        message: imageRequestResult.message,
        source: aiProviderName === "openrouter" ? "openrouter_agent" : "hermes_tools",
        sender
      };
    }
  }

  const ownerOrderDecision =
    sender.role === "owner" || sender.role === "manager"
      ? parseOwnerOrderDecision(message)
      : null;
  const simpleOwnerDecision =
    sender.role === "owner" || sender.role === "manager"
      ? parseSimpleOwnerDecision(message)
      : null;

  if (sender.role === "owner" || sender.role === "manager") {
    const selectionResult = await handleSavedOwnerSelectionReply(
      restaurantId,
      sender.normalizedPhone,
      message
    );

    if (selectionResult.handled) {
      await saveAgentConversationMessage({
        restaurantId,
        senderPhone: sender.normalizedPhone,
        senderRole: sender.role,
        direction: "assistant",
        content: selectionResult.message,
        metadata: {
          source: "deterministic_owner_order_selection",
          success: selectionResult.success
        }
      });

      return {
        success: selectionResult.success,
        message: selectionResult.message,
        data: selectionResult.data,
        source: aiProviderName === "openrouter" ? "openrouter_agent" : "hermes_tools",
        sender
      };
    }
  }

  if (simpleOwnerDecision) {
    const quotedResult = await resolveQuotedOwnerOrderDecision(
      restaurantId,
      input.quotedMessageId,
      simpleOwnerDecision
    );
    const result = quotedResult.handled
      ? quotedResult
      : await handleUnquotedOwnerOrderDecision(
          restaurantId,
          sender.normalizedPhone,
          simpleOwnerDecision
        );

    await saveAgentConversationMessage({
      restaurantId,
      senderPhone: sender.normalizedPhone,
      senderRole: sender.role,
      direction: "assistant",
      content: result.message,
      metadata: {
        source: quotedResult.handled
          ? "deterministic_quoted_owner_order_decision"
          : "deterministic_simple_owner_order_decision",
        success: result.success
      }
    });

    return {
      success: result.success,
      message: result.message,
      data: result.data,
      source: aiProviderName === "openrouter" ? "openrouter_agent" : "hermes_tools",
      sender
    };
  }

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
      // Handle numbered replies: "1", "2", "Yes 1", "Yes 2", etc.
      // The owner is picking a specific action from the numbered list we showed them.
      const numberMatch = message.trim().match(/(\d+)$/);

      if (numberMatch) {
        const selectedIndex = parseInt(numberMatch[1], 10) - 1;
        const selectedAction = pendingActions[selectedIndex];

        if (selectedAction) {
          // Cancel all other pending actions so they don't accumulate
          const otherIds = pendingActions
            .filter((_, i) => i !== selectedIndex)
            .map((a) => a._id);

          if (otherIds.length > 0) {
            await PendingAgentAction.updateMany(
              { _id: { $in: otherIds } },
              {
                $set: {
                  status: "cancelled",
                  resultMessage: "Superseded by owner selection."
                }
              }
            );
          }

          const result = await executeConfirmedPendingToolAction(
            String(selectedAction._id),
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
              deterministicAction: "confirm_pending_action_by_number",
              selectedIndex,
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
      }

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
