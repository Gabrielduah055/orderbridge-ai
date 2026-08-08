import { executeAgentTool } from "../../agent-tools/tool.executor";
import {
  getRecentAgentConversationHistory,
  saveAgentConversationMessage
} from "../agentConversationHistory.service";
import { getOpenRouterConfig } from "./ai.config";
import { createAiProvider } from "./aiProvider.factory";
import { buildAgentSystemPrompt } from "./agentPrompt.service";
import {
  getAgentToolDefinitionsForRole,
  getPermittedAgentToolNamesForRole
} from "./agentToolDefinitions.service";
import type {
  AgentOrchestratorInput,
  AgentOrchestratorResult,
  AgentToolExecutor,
  AiMessage,
  AiProvider,
  AiUsage,
  ExecutedAgentTool
} from "./ai.types";
import type {
  SaveAgentMessageInput,
  ToolExecutionContext,
  ToolResult
} from "../../types/agent.types";
import type { IOrderDocument } from "../../models/order.model";

const safeFallbackMessage =
  "I'm having trouble reaching the restaurant system right now. Please try again shortly.";
const maxRoundsFallbackMessage =
  "I'm sorry, I had a little trouble with that one. Could you try again or rephrase what you'd like?";
const recoverableToolCodes = new Set([
  "MULTIPLE_MENU_ITEMS_FOUND",
  "ORDER_ITEM_QUANTITY_REQUIRED",
  "ORDER_ITEM_CLARIFICATION_NO_MATCH",
  "ORDER_DRAFT_INCOMPLETE",
  "CUSTOMER_NAME_REQUIRED",
  "ORDER_REJECTION_REASON_REQUIRED"
]);

const classifyOrchestratorError = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return "INTERNAL_ERROR";
  }

  if (error.name === "AbortError" || /\babort|timeout|timed out\b/i.test(error.message)) {
    return "PROVIDER_TIMEOUT";
  }

  if (/OpenRouter request failed with status/i.test(error.message)) {
    return "OPENROUTER_HTTP_ERROR";
  }

  if (/did not include a message|did not include text or tool calls|empty final response/i.test(error.message)) {
    return "PROVIDER_EMPTY_RESPONSE";
  }

  if (/JSON|parse|malformed/i.test(error.message)) {
    return "MALFORMED_TOOL_ARGUMENTS";
  }

  return "INTERNAL_ERROR";
};

const trustedArgumentNames = new Set([
  "restaurantId",
  "restaurant_id",
  "senderPhone",
  "sender_phone",
  "senderRole",
  "sender_role",
  "sessionKey",
  "session_key",
  "conversationKey",
  "conversation_key"
]);

const normalizeText = (value: string): string => value.trim().replace(/\s+/g, " ");

const stripTrustedModelArguments = (
  args: Record<string, unknown>
): Record<string, unknown> => {
  return Object.fromEntries(
    Object.entries(args).filter(([key]) => !trustedArgumentNames.has(key))
  );
};

const orderMutationToolNames = new Set([
  "cancel_order",
  "confirm_order",
  "reject_order",
  "update_order_status"
]);

const getRequestedOrderReferences = (
  args: Record<string, unknown>
): string[] => {
  return [args.orderId, args.orderReference]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
};

const referencesMatchAllowedValues = (
  requestedReferences: string[],
  allowedReferences: Array<string | undefined>
): boolean => {
  const allowed = new Set(
    allowedReferences
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );

  return (
    requestedReferences.length > 0 &&
    allowed.size > 0 &&
    requestedReferences.every((reference) => allowed.has(reference))
  );
};

const getTrustedOrderReferenceGuardResult = (
  input: AgentOrchestratorInput,
  toolName: string,
  args: Record<string, unknown>
): ToolResult | null => {
  if (
    (input.sender.role !== "owner" && input.sender.role !== "manager") ||
    !orderMutationToolNames.has(toolName)
  ) {
    return null;
  }

  const requestedReferences = getRequestedOrderReferences(args);
  const selection = input.staffState?.recentReferences.orderSelection;

  if (selection?.decision === "reject" && selection.awaitingReason) {
    if (toolName !== "reject_order") {
      return {
        success: false,
        code: "ORDER_WORKFLOW_CONFLICT",
        message:
          "Only rejecting one of the selected orders is allowed while the rejection reason is pending."
      };
    }

    const allowedOrderIds = selection.candidates.map((candidate) => candidate.id);

    if (!referencesMatchAllowedValues(requestedReferences, allowedOrderIds)) {
      return {
        success: false,
        code: "ORDER_REFERENCE_MISMATCH",
        message: "The requested order does not match the active order selection."
      };
    }
  }

  const explicitCurrentReference = input.message.match(
    /\b(ORD-[A-Za-z0-9-]+|[a-f0-9]{24})\b/i
  )?.[1];
  const quotedOrder = input.staffState?.recentReferences.quotedOrder;

  if (input.quotedMessageId && !explicitCurrentReference && quotedOrder) {
    if (
      !referencesMatchAllowedValues(requestedReferences, [
        quotedOrder.id,
        quotedOrder.orderNumber
      ])
    ) {
      return {
        success: false,
        code: "ORDER_REFERENCE_MISMATCH",
        message: "The requested order does not match the quoted order."
      };
    }
  }

  return null;
};

const toConversationMessage = (message: {
  role: string;
  content: string;
}): AiMessage | null => {
  if (message.role !== "user" && message.role !== "assistant") {
    return null;
  }

  return {
    role: message.role,
    content: message.content
  };
};

const buildToolResultForModel = (toolName: string, result: ToolResult) => ({
  success: result.success,
  tool: toolName,
  message: result.message,
  code: result.code,
  data: removeImageUrlsForModel(result.data),
  requiresConfirmation: result.requiresConfirmation,
  pendingActionId: result.pendingActionId
});

const getExecutedOrderMetadata = (data: unknown) => {
  if (!data || typeof data !== "object") {
    return {};
  }

  const order = (data as Record<string, unknown>).order;
  if (!order || typeof order !== "object") {
    return {};
  }

  const source = order as Record<string, unknown>;
  const rawId = source.id ?? source._id;

  return {
    resultOrderId:
      rawId === undefined || rawId === null ? undefined : String(rawId),
    resultOrderNumber:
      typeof source.orderNumber === "string" ? source.orderNumber : undefined,
    resultOrderStatus:
      typeof source.status === "string" ? source.status : undefined
  };
};

const removeImageUrlsForModel = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(removeImageUrlsForModel);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const source = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  let hasImage = false;

  for (const [key, entryValue] of Object.entries(source)) {
    if (key === "imageUrl") {
      hasImage = typeof entryValue === "string" && Boolean(entryValue.trim());
      continue;
    }

    sanitized[key] = removeImageUrlsForModel(entryValue);
  }

  if (hasImage) {
    sanitized.hasImage = true;
  }

  return sanitized;
};

const getImportantData = (
  currentData: AgentOrchestratorResult["data"],
  result: ToolResult,
  toolName: string
): AgentOrchestratorResult["data"] => {
  const nextData = { ...(currentData ?? {}) };

  if (Array.isArray(result.data) && result.data.length === 1) {
    const onlyItem = result.data[0];

    if (onlyItem && typeof onlyItem === "object") {
      const item = onlyItem as Record<string, unknown>;

      if (
        toolName === "search_menu_items" &&
        typeof item.imageUrl === "string" &&
        item.imageUrl.trim() &&
        typeof item.name === "string" &&
        item.name.trim()
      ) {
        nextData.menuItemImage = {
          imageUrl: item.imageUrl,
          caption: item.name,
          source: "search_menu_items_tool"
        };
      }
    }
  } else if (result.data && typeof result.data === "object") {
    const data = result.data as Record<string, unknown>;

    if (data.order) {
      nextData.order = data.order as IOrderDocument;
    }

    for (const key of [
      "orderEvent",
      "notifyOwner",
      "notifyCustomer",
      "receiptRequired",
      "orderSubmitted",
      "idempotent"
    ]) {
      if (key in data) {
        nextData[key] = data[key];
      }
    }
  }

  if (result.pendingActionId) {
    nextData.pendingActionId = result.pendingActionId;
  }

  return Object.keys(nextData).length > 0 ? nextData : undefined;
};

const sanitizeMenuItemImageResponse = (
  message: string,
  data: AgentOrchestratorResult["data"]
): string => {
  const candidate = data?.menuItemImage;

  if (!candidate || typeof candidate !== "object") {
    return message;
  }

  const caption = (candidate as Record<string, unknown>).caption;

  if (/https?:\/\/\S+/i.test(message)) {
    return typeof caption === "string" && caption.trim()
      ? `Here is ${caption}.`
      : "Here is the saved menu-item image.";
  }

  const withoutUrls = message
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/ {2,}/g, " ")
    .trim();

  if (withoutUrls) {
    return withoutUrls;
  }

  return typeof caption === "string" && caption.trim()
    ? `Here is ${caption}.`
    : "Here is the saved menu-item image.";
};

const mergeUsage = (current: AiUsage | undefined, next: AiUsage | undefined): AiUsage | undefined => {
  if (!next) {
    return current;
  }

  return {
    inputTokens: (current?.inputTokens ?? 0) + (next.inputTokens ?? 0),
    outputTokens: (current?.outputTokens ?? 0) + (next.outputTokens ?? 0),
    totalTokens: (current?.totalTokens ?? 0) + (next.totalTokens ?? 0)
  };
};

const looksLikeSuccessClaim = (message: string): boolean => {
  return /\b(done|completed|confirmed|placed|updated|cancelled|successfully|has been|is now)\b/i.test(
    message
  );
};

const getFailedToolSuccessClaimMessage = (
  finalMessage: string,
  executedTools: ExecutedAgentTool[]
): string | null => {
  const failedTool = executedTools.find((tool) => !tool.success);

  if (!failedTool || !looksLikeSuccessClaim(finalMessage)) {
    return null;
  }

  return failedTool.message || "I couldn't complete that request.";
};

const getRecoverableToolFallbackMessage = (
  executedTools: ExecutedAgentTool[]
): string | null => {
  const latestRecoverable = [...executedTools]
    .reverse()
    .find((tool) => tool.code && recoverableToolCodes.has(tool.code));

  return latestRecoverable?.message ?? null;
};

export interface AgentOrchestratorDependencies {
  provider?: AiProvider;
  getHistory?: typeof getRecentAgentConversationHistory;
  saveMessage?: (input: SaveAgentMessageInput) => Promise<void>;
  executeTool?: AgentToolExecutor;
  buildSystemPrompt?: typeof buildAgentSystemPrompt;
}

export const runAgentOrchestrator = async (
  input: AgentOrchestratorInput,
  dependencies: AgentOrchestratorDependencies = {}
): Promise<AgentOrchestratorResult> => {
  const provider = dependencies.provider ?? createAiProvider();
  const getHistory = dependencies.getHistory ?? getRecentAgentConversationHistory;
  const saveMessage = dependencies.saveMessage ?? saveAgentConversationMessage;
  const buildSystemPrompt = dependencies.buildSystemPrompt ?? buildAgentSystemPrompt;
  const restaurantId = String(input.restaurant._id);
  const conversationKey = `${restaurantId}:${input.sender.normalizedPhone}`;
  const tools = getAgentToolDefinitionsForRole(input.sender.role);
  const permittedToolNames = getPermittedAgentToolNamesForRole(input.sender.role);
  const systemPrompt = await buildSystemPrompt(
    input.restaurant,
    input.sender,
    Array.from(permittedToolNames),
    {},
    input.staffState
  );
  const history = await getHistory(restaurantId, input.sender.normalizedPhone, 14);
  const messages: AiMessage[] = [
    {
      role: "system",
      content: systemPrompt
    },
    ...history
      .map(toConversationMessage)
      .filter((message): message is AiMessage => Boolean(message))
  ];
  const normalizedInputMessage = normalizeText(input.message);
  const latestHistoryMessage = history[history.length - 1];

  if (
    latestHistoryMessage?.role !== "user" ||
    normalizeText(latestHistoryMessage.content) !== normalizedInputMessage
  ) {
    messages.push({
      role: "user",
      content: normalizedInputMessage
    });
  }

  const executedTools: ExecutedAgentTool[] = [];
  let importantData: AgentOrchestratorResult["data"];
  let responseId: string | undefined;
  let usage: AiUsage | undefined;
  const startedAt = Date.now();
  const maxToolRounds = getOpenRouterConfig().maxToolRounds;
  const executeTool = dependencies.executeTool ?? executeAgentTool;
  const toolExecutionContext: ToolExecutionContext = {
    restaurantId,
    restaurant: input.restaurant,
    sender: input.sender,
    originalMessage: normalizedInputMessage,
    quotedMessageId: input.quotedMessageId
  };

  try {
    for (let round = 0; round < maxToolRounds; round += 1) {
      const response = await provider.complete({
        messages,
        tools,
        toolChoice: tools.length > 0 ? "auto" : "none"
      });
      responseId = response.id ?? responseId;
      usage = mergeUsage(usage, response.usage);

      if (response.toolCalls.length === 0) {
        const rawFinalMessage = response.text?.trim();

        if (!rawFinalMessage) {
          throw new Error("Agent provider returned an empty final response.");
        }

        const finalMessage = sanitizeMenuItemImageResponse(rawFinalMessage, importantData);

        const failedToolMessage = getFailedToolSuccessClaimMessage(finalMessage, executedTools);

        if (failedToolMessage) {
          return {
            success: false,
            message: failedToolMessage,
            data: importantData,
            provider: provider.name,
            model: provider.model,
            responseId,
            executedTools,
            usage
          };
        }

        console.info("Restaurant agent completed", {
          provider: provider.name,
          model: provider.model,
          restaurantId,
          senderRole: input.sender.role,
          conversationKey,
          toolRoundCount: round,
          requestedToolNames: executedTools.map((tool) => tool.name),
          latencyMs: Date.now() - startedAt,
          totalTokens: usage?.totalTokens
        });

        return {
          success: true,
          message: finalMessage,
          data: importantData,
          provider: provider.name,
          model: provider.model,
          responseId,
          executedTools,
          usage
        };
      }

      messages.push({
        role: "assistant",
        content: response.text ?? null,
        toolCalls: response.toolCalls
      });

      for (const toolCall of response.toolCalls) {
        const toolName = toolCall.name;
        const safeArguments = stripTrustedModelArguments(toolCall.arguments);
        const trustedReferenceGuardResult = getTrustedOrderReferenceGuardResult(
          input,
          toolName,
          safeArguments
        );
        const result = toolCall.invalidArguments
          ? {
              success: false,
              code: "TOOL_INVALID_ARGUMENTS",
              message:
                "The tool arguments were malformed. Please retry the tool call with valid JSON arguments."
            }
          : permittedToolNames.has(toolName)
            ? trustedReferenceGuardResult ??
              (await executeTool(
                toolName,
                safeArguments,
                toolExecutionContext
              ))
            : {
                success: false,
                code: "TOOL_FORBIDDEN",
                message: "That tool is not available for the current sender role."
              };

        executedTools.push({
          name: toolName,
          success: result.success,
          code: result.code,
          message: result.message,
          requiresConfirmation: result.requiresConfirmation,
          pendingActionId: result.pendingActionId,
          ...getExecutedOrderMetadata(result.data)
        });
        importantData = getImportantData(importantData, result, toolName);

        await saveMessage({
          restaurantId,
          senderPhone: input.sender.normalizedPhone,
          senderRole: input.sender.role,
          direction: "tool",
          content: JSON.stringify(buildToolResultForModel(toolName, result)),
          metadata: {
            source: "openrouter_agent",
            provider: provider.name,
            model: provider.model,
            toolName,
            success: result.success,
            code: result.code,
            requiresConfirmation: result.requiresConfirmation,
            invalidArguments: toolCall.invalidArguments
          }
        });

        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          name: toolName,
          content: JSON.stringify(buildToolResultForModel(toolName, result))
        });
      }
    }

    const recoverableMessage = getRecoverableToolFallbackMessage(executedTools);

    return {
      success: false,
      message: recoverableMessage ?? maxRoundsFallbackMessage,
      data: importantData,
      provider: provider.name,
      model: provider.model,
      responseId,
      executedTools,
      usage
    };
  } catch (error) {
    const errorCode = classifyOrchestratorError(error);

    console.error("Restaurant agent orchestration failed", {
      provider: provider.name,
      model: provider.model,
      restaurantId,
      senderRole: input.sender.role,
      conversationKey,
      requestedToolNames: executedTools.map((tool) => tool.name),
      latencyMs: Date.now() - startedAt,
      errorCode,
      error: error instanceof Error ? error.message : "Unknown agent orchestration error"
    });

    return {
      success: false,
      message: safeFallbackMessage,
      data: importantData,
      errorCode,
      provider: provider.name,
      model: provider.model,
      responseId,
      executedTools,
      usage
    };
  }
};
