import { ZodError } from "zod";
import { PendingAgentAction } from "../models/pendingAgentAction.model";
import type { ToolExecutionContext, ToolResult } from "../types/agent.types";
import { isToolAllowedForRole, type ToolName } from "./tool.permissions";
import { toolRegistry } from "./tool.registry";
import { getSafeErrorMessage } from "../utils/error.util";
import { BadRequestError } from "../utils/httpErrors";

const isToolName = (toolName: string): toolName is ToolName => {
  return toolName in toolRegistry;
};

const safeValidationMessage = (error: ZodError): string => {
  const firstIssue = error.issues[0];

  return firstIssue?.message ?? "Tool arguments are invalid.";
};

export const executeAgentTool = async (
  toolName: string,
  rawArgs: unknown,
  context: ToolExecutionContext
): Promise<ToolResult> => {
  console.info("Agent tool requested", {
    restaurantId: context.restaurantId,
    senderRole: context.sender.role,
    toolName
  });

  if (!isToolName(toolName)) {
    return {
      success: false,
      code: "TOOL_NOT_FOUND",
      message: "That tool is not available."
    };
  }

  const tool = toolRegistry[toolName];

  if (!isToolAllowedForRole(toolName, context.sender.role)) {
    console.warn("Agent tool denied", {
      restaurantId: context.restaurantId,
      senderRole: context.sender.role,
      toolName
    });

    return {
      success: false,
      code: "TOOL_FORBIDDEN",
      message: "This action is not available for the current sender role."
    };
  }

  const parseResult = tool.schema.safeParse(rawArgs ?? {});

  if (!parseResult.success) {
    const rejectionReasonMissing =
      toolName === "reject_order" &&
      parseResult.error.issues.some((issue) => issue.path[0] === "reason");

    return {
      success: false,
      code: rejectionReasonMissing
        ? "ORDER_REJECTION_REASON_REQUIRED"
        : "TOOL_INVALID_ARGUMENTS",
      message: rejectionReasonMissing
        ? "Please provide a meaningful reason for rejecting the order."
        : safeValidationMessage(parseResult.error)
    };
  }

  try {
    const result = await tool.handler(parseResult.data, context);

    console.info("Agent tool completed", {
      restaurantId: context.restaurantId,
      senderRole: context.sender.role,
      toolName,
      success: result.success,
      code: result.code,
      requiresConfirmation: result.requiresConfirmation
    });

    return result;
  } catch (error) {
    console.error("Agent tool execution failed", {
      restaurantId: context.restaurantId,
      senderRole: context.sender.role,
      toolName,
      error: getSafeErrorMessage(error, "Agent tool execution failed without an error message")
    });

    if (error instanceof BadRequestError && error.code) {
      return {
        success: false,
        code: error.code,
        message: error.message
      };
    }

    return {
      success: false,
      code: "TOOL_EXECUTION_FAILED",
      message: "I could not complete that action right now."
    };
  }
};

export const executeConfirmedPendingToolAction = async (
  pendingActionId: string,
  context: ToolExecutionContext,
  expectedToolName?: ToolName
): Promise<ToolResult> => {
  const pendingAction = await PendingAgentAction.findOne({
    _id: pendingActionId,
    restaurantId: context.restaurantId,
    senderPhone: context.sender.normalizedPhone,
    senderRole: context.sender.role,
    action: "TOOL_CALL",
    ...(expectedToolName
      ? {
          toolName: expectedToolName
        }
      : {}),
    status: "pending",
    expiresAt: {
      $gt: new Date()
    }
  });

  if (!pendingAction || !pendingAction.toolName) {
    return {
      success: false,
      code: "PENDING_ACTION_NOT_FOUND",
      message: "There is no pending action to confirm."
    };
  }

  const result = await executeAgentTool(
    pendingAction.toolName,
    pendingAction.arguments ?? pendingAction.data,
    {
      ...context,
      confirmed: true
    }
  );

  pendingAction.status = result.success ? "completed" : "failed";
  pendingAction.resultMessage = result.message;
  pendingAction.errorMessage = result.success ? undefined : result.message;
  await pendingAction.save();

  console.info("Agent confirmation executed", {
    restaurantId: context.restaurantId,
    senderRole: context.sender.role,
    toolName: pendingAction.toolName,
    success: result.success
  });

  return result;
};

export const cancelPendingToolAction = async (
  context: ToolExecutionContext
): Promise<ToolResult> => {
  const pendingAction = await PendingAgentAction.findOne({
    restaurantId: context.restaurantId,
    senderPhone: context.sender.normalizedPhone,
    senderRole: context.sender.role,
    action: "TOOL_CALL",
    status: "pending",
    expiresAt: {
      $gt: new Date()
    }
  }).sort({ createdAt: -1 });

  if (!pendingAction) {
    return {
      success: false,
      code: "PENDING_ACTION_NOT_FOUND",
      message: "There is no pending action to cancel."
    };
  }

  pendingAction.status = "cancelled";
  pendingAction.resultMessage = "Pending action cancelled.";
  await pendingAction.save();

  return {
    success: true,
    message: "Okay, I cancelled that pending action."
  };
};

export const cancelPendingToolActionById = async (
  pendingActionId: string,
  context: ToolExecutionContext
): Promise<ToolResult> => {
  const pendingAction = await PendingAgentAction.findOne({
    _id: pendingActionId,
    restaurantId: context.restaurantId,
    senderPhone: context.sender.normalizedPhone,
    senderRole: context.sender.role,
    action: "TOOL_CALL",
    status: "pending",
    expiresAt: {
      $gt: new Date()
    }
  });

  if (!pendingAction) {
    return {
      success: false,
      code: "PENDING_ACTION_NOT_FOUND",
      message: "There is no pending action to cancel."
    };
  }

  pendingAction.status = "cancelled";
  pendingAction.resultMessage = "Pending action cancelled.";
  await pendingAction.save();

  return {
    success: true,
    message: "Okay, I cancelled that pending action."
  };
};

export const findLatestPendingToolAction = async (
  context: ToolExecutionContext
) => {
  return PendingAgentAction.findOne({
    restaurantId: context.restaurantId,
    senderPhone: context.sender.normalizedPhone,
    senderRole: context.sender.role,
    action: "TOOL_CALL",
    status: "pending",
    expiresAt: {
      $gt: new Date()
    }
  }).sort({ createdAt: -1 });
};

export const findPendingToolActions = async (
  context: ToolExecutionContext
) => {
  return PendingAgentAction.find({
    restaurantId: context.restaurantId,
    senderPhone: context.sender.normalizedPhone,
    senderRole: context.sender.role,
    action: "TOOL_CALL",
    status: "pending",
    expiresAt: {
      $gt: new Date()
    }
  }).sort({ createdAt: -1 });
};
