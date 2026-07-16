import type { Request, Response } from "express";
import { Types } from "mongoose";
import {
  cancelPendingToolAction,
  executeAgentTool,
  executeConfirmedPendingToolAction,
  findLatestPendingToolAction
} from "../agent-tools/tool.executor";
import { Restaurant } from "../models/Restaurant";
import { resolveSenderIdentity } from "../services/senderIdentity.service";
import type { ResolvedSender } from "../types/agent.types";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

interface McpToolCallParams {
  name?: string;
  arguments?: Record<string, unknown>;
}

const toolNameByMcpName: Record<string, string> = {
  get_menu: "get_menu",
  add_menu_items: "add_menu_items",
  update_price: "update_menu_price",
  set_availability: "set_item_availability",
  get_orders: "get_today_orders",
  get_today_orders: "get_today_orders",
  start_order: "start_order",
  add_order_item_by_name: "add_order_item_by_name",
  remove_order_item_by_name: "remove_order_item_by_name",
  update_order_draft: "update_order_draft",
  get_order_draft: "get_order_draft",
  confirm_order_draft: "confirm_order_draft",
  cancel_order_draft: "cancel_order_draft",
  confirm_pending_action: "confirm_pending_action",
  cancel_pending_action: "cancel_pending_action"
};

const jsonRpcResult = (id: JsonRpcId | undefined, result: unknown) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  result
});

const jsonRpcError = (id: JsonRpcId | undefined, code: number, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: {
    code,
    message
  }
});

const getBearerToken = (req: Request): string | null => {
  const authorization = req.header("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);

  return match?.[1]?.trim() ?? null;
};

export const getAllowedMcpTokens = (): string[] => {
  return [process.env.MCP_SHARED_SECRET]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
};

export const isMcpBearerTokenAuthorized = (bearerToken: string | null): boolean => {
  const allowedTokens = getAllowedMcpTokens();

  return Boolean(bearerToken && allowedTokens.includes(bearerToken));
};

const isMcpRequestAuthorized = (req: Request): boolean =>
  isMcpBearerTokenAuthorized(getBearerToken(req));

const toolInputSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: {
    sessionKey: {
      type: "string",
      description: "Required stable Hermes session key in the format restaurantId:normalizedSenderPhone."
    },
    ...properties
  },
  required: ["sessionKey", ...required],
  additionalProperties: false
});

export const mcpTools = [
  {
    name: "get_menu",
    description: "Read the restaurant menu for the current sender.",
    inputSchema: toolInputSchema({
      availableOnly: { type: "boolean" }
    })
  },
  {
    name: "add_menu_items",
    description: "Owner-only. Add one or more menu items, creating categories by name when needed.",
    inputSchema: toolInputSchema(
      {
        items: {
          type: "array",
          minItems: 1,
          maxItems: 30,
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              price: { type: "number" },
              categoryName: { type: "string" },
              description: { type: "string" },
              isAvailable: { type: "boolean" }
            },
            required: ["name", "price"],
            additionalProperties: false
          }
        }
      },
      ["items"]
    )
  },
  {
    name: "update_price",
    description: "Owner-only. Update a menu item's price after the owner has confirmed.",
    inputSchema: toolInputSchema(
      {
        itemName: { type: "string" },
        item_name: { type: "string" },
        itemId: { type: "string" },
        price: { type: "number" },
        newPrice: { type: "number" },
        new_price: { type: "number" }
      }
    )
  },
  {
    name: "set_availability",
    description: "Owner/manager. Set a menu item's availability.",
    inputSchema: toolInputSchema(
      {
        itemName: { type: "string" },
        item_name: { type: "string" },
        itemId: { type: "string" },
        available: { type: "boolean" },
        isAvailable: { type: "boolean" },
        is_available: { type: "boolean" }
      }
    )
  },
  {
    name: "get_orders",
    description: "Owner/manager. Read today's orders summary.",
    inputSchema: toolInputSchema({})
  },
  {
    name: "start_order",
    description:
      "Customer-only. Start or resume this customer's order draft. Call this first when a customer wants to order.",
    inputSchema: toolInputSchema({
      customerName: { type: "string" },
      customer_name: { type: "string" }
    })
  },
  {
    name: "add_order_item_by_name",
    description:
      "Customer-only. Add a menu item to the customer's order draft by name. The backend resolves the name and stores it. If ambiguous, returns candidates instead of adding anything.",
    inputSchema: toolInputSchema(
      {
        itemName: { type: "string" },
        item_name: { type: "string" },
        quantity: { type: "number" }
      }
    )
  },
  {
    name: "remove_order_item_by_name",
    description: "Customer-only. Remove a menu item from the order draft by name.",
    inputSchema: toolInputSchema(
      {
        itemName: { type: "string" },
        item_name: { type: "string" }
      }
    )
  },
  {
    name: "update_order_draft",
    description:
      "Customer-only. Update customer name, order type (pickup/delivery), and/or delivery address on the current order draft. Call whenever the customer gives any of this information, in any order.",
    inputSchema: toolInputSchema({
      customerName: { type: "string" },
      customer_name: { type: "string" },
      orderType: { type: "string", enum: ["pickup", "delivery"] },
      order_type: { type: "string", enum: ["pickup", "delivery"] },
      deliveryAddress: { type: "string" },
      delivery_address: { type: "string" }
    })
  },
  {
    name: "get_order_draft",
    description:
      "Customer-only. Read back the current order draft and which fields are still missing before it can be confirmed.",
    inputSchema: toolInputSchema({})
  },
  {
    name: "confirm_order_draft",
    description:
      "Customer-only. Finalize the order draft into a real order once items, order type, delivery address if delivery, and customer name are all present. Confirm with the customer before calling this.",
    inputSchema: toolInputSchema({})
  },
  {
    name: "cancel_order_draft",
    description: "Customer-only. Clear the current order draft.",
    inputSchema: toolInputSchema({})
  },
  {
    name: "confirm_pending_action",
    description:
      "Confirm the latest pending backend action for this session after the user has explicitly confirmed it.",
    inputSchema: toolInputSchema({
      pendingActionId: { type: "string" },
      pending_action_id: { type: "string" }
    })
  },
  {
    name: "cancel_pending_action",
    description: "Cancel the latest pending backend action for this session.",
    inputSchema: toolInputSchema({})
  }
];

const normalizeToolArguments = (
  mcpToolName: string,
  args: Record<string, unknown>
): Record<string, unknown> => {
  const { sessionKey: _sessionKey, ...toolArgs } = args;

  if (mcpToolName === "update_price") {
    const { price, new_price: newPriceAlias, item_name: itemNameAlias, ...rest } = toolArgs;

    return {
      ...rest,
      itemName: rest.itemName ?? itemNameAlias,
      newPrice: rest.newPrice ?? newPriceAlias ?? price
    };
  }

  if (mcpToolName === "set_availability") {
    const { isAvailable, is_available: isAvailableAlias, item_name: itemNameAlias, ...rest } = toolArgs;

    return {
      ...rest,
      itemName: rest.itemName ?? itemNameAlias,
      available: rest.available ?? isAvailable ?? isAvailableAlias
    };
  }

  if (mcpToolName === "start_order") {
    const { customer_name: customerNameAlias, ...rest } = toolArgs;

    return {
      ...rest,
      customerName: rest.customerName ?? customerNameAlias
    };
  }

  if (mcpToolName === "add_order_item_by_name" || mcpToolName === "remove_order_item_by_name") {
    const { item_name: itemNameAlias, ...rest } = toolArgs;

    return {
      ...rest,
      itemName: rest.itemName ?? itemNameAlias
    };
  }

  if (mcpToolName === "update_order_draft") {
    const {
      customer_name: customerNameAlias,
      order_type: orderTypeAlias,
      delivery_address: deliveryAddressAlias,
      ...rest
    } = toolArgs;

    return {
      ...rest,
      customerName: rest.customerName ?? customerNameAlias,
      orderType: rest.orderType ?? orderTypeAlias,
      deliveryAddress: rest.deliveryAddress ?? deliveryAddressAlias
    };
  }

  return toolArgs;
};

const getSessionKey = (args: Record<string, unknown>): string | null => {
  return typeof args.sessionKey === "string" && args.sessionKey.trim()
    ? args.sessionKey.trim()
    : null;
};

const parseSessionKey = (
  sessionKey: string
): { restaurantId: string; senderPhone: string } | null => {
  const separatorIndex = sessionKey.indexOf(":");

  if (separatorIndex <= 0 || separatorIndex === sessionKey.length - 1) {
    return null;
  }

  const restaurantId = sessionKey.slice(0, separatorIndex).trim();
  const senderPhone = sessionKey.slice(separatorIndex + 1).trim();

  if (!Types.ObjectId.isValid(restaurantId) || !senderPhone) {
    return null;
  }

  return {
    restaurantId,
    senderPhone
  };
};

const normalizePendingActionId = (rawArgs: Record<string, unknown>): string | null => {
  const value = rawArgs.pendingActionId ?? rawArgs.pending_action_id;

  return typeof value === "string" && value.trim() ? value.trim() : null;
};

const callTool = async (params: McpToolCallParams) => {
  const mcpToolName = params.name;
  const rawArgs =
    params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
      ? params.arguments
      : {};

  if (!mcpToolName || !toolNameByMcpName[mcpToolName]) {
    return {
      success: false,
      code: "MCP_TOOL_NOT_FOUND",
      message: "Tool not found."
    };
  }

  const sessionKey = getSessionKey(rawArgs);
  const sessionContext = sessionKey ? parseSessionKey(sessionKey) : null;

  if (!sessionContext) {
    return {
      success: false,
      code: "MCP_SESSION_INVALID",
      message: "The tool session context is invalid."
    };
  }

  const restaurant = await Restaurant.findById(sessionContext.restaurantId).select("+wasenderApiToken");

  if (!restaurant) {
    return {
      success: false,
      code: "RESTAURANT_NOT_FOUND",
      message: "Restaurant not found."
    };
  }

  const sender: ResolvedSender = resolveSenderIdentity(restaurant, sessionContext.senderPhone);
  const executionContext = {
    restaurantId: sessionContext.restaurantId,
    restaurant,
    sender
  };

  if (mcpToolName === "confirm_pending_action") {
    const pendingActionId = normalizePendingActionId(rawArgs);
    const pendingAction = pendingActionId
      ? null
      : await findLatestPendingToolAction(executionContext);
    const actionId = pendingActionId ?? (pendingAction ? String(pendingAction._id) : null);

    if (!actionId) {
      return {
        success: false,
        code: "PENDING_ACTION_NOT_FOUND",
        message: "There is no pending action to confirm."
      };
    }

    return executeConfirmedPendingToolAction(
      actionId,
      executionContext
    );
  }

  if (mcpToolName === "cancel_pending_action") {
    return cancelPendingToolAction(executionContext);
  }

  return executeAgentTool(
    toolNameByMcpName[mcpToolName],
    normalizeToolArguments(mcpToolName, rawArgs),
    executionContext
  );
};

const handleJsonRpc = async (request: JsonRpcRequest) => {
  if (request.method === "initialize") {
    return jsonRpcResult(request.id, {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {}
      },
      serverInfo: {
        name: "orderbridge-restaurant-api",
        version: "1.0.0"
      }
    });
  }

  if (request.method === "tools/list") {
    return jsonRpcResult(request.id, {
      tools: mcpTools
    });
  }

  if (request.method === "tools/call") {
    const result = await callTool((request.params ?? {}) as McpToolCallParams);

    return jsonRpcResult(request.id, {
      content: [
        {
          type: "text",
          text: JSON.stringify(result)
        }
      ],
      isError: !result.success
    });
  }

  if (request.method?.startsWith("notifications/")) {
    return null;
  }

  return jsonRpcError(request.id, -32601, "Method not found");
};

export const handleMcpRequest = async (req: Request, res: Response): Promise<void> => {
  if (!isMcpRequestAuthorized(req)) {
    res.status(401).json({
      error: "Unauthorized"
    });
    return;
  }

  const body = req.body;

  if (Array.isArray(body)) {
    const results = await Promise.all(body.map((item) => handleJsonRpc(item as JsonRpcRequest)));
    res.status(200).json(results.filter(Boolean));
    return;
  }

  const result = await handleJsonRpc(body as JsonRpcRequest);

  if (!result) {
    res.status(202).send();
    return;
  }

  res.status(200).json(result);
};
