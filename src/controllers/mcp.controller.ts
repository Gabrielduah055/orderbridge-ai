import type { Request, Response } from "express";
import { executeAgentTool } from "../agent-tools/tool.executor";
import { Restaurant } from "../models/Restaurant";
import { verifyHermesContextToken } from "../services/hermesAgent.service";
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
  create_order: "create_order",
  get_orders: "get_today_orders",
  get_today_orders: "get_today_orders"
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

const getAllowedMcpTokens = (): string[] => {
  return [
    process.env.MCP_SHARED_SECRET,
    process.env.HERMES_MCP_TOKEN,
    process.env.HERMES_API_SERVER_KEY
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
};

const isMcpRequestAuthorized = (req: Request): boolean => {
  const allowedTokens = getAllowedMcpTokens();

  if (allowedTokens.length === 0 && process.env.NODE_ENV !== "production") {
    return true;
  }

  const bearerToken = getBearerToken(req);

  return Boolean(bearerToken && allowedTokens.includes(bearerToken));
};

const toolInputSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: {
    contextToken: {
      type: "string",
      description: "Required signed backend context token from the current Hermes response input."
    },
    ...properties
  },
  required: ["contextToken", ...required],
  additionalProperties: false
});

const tools = [
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
    name: "create_order",
    description: "Customer-only. Create an order from explicit menu item IDs and quantities.",
    inputSchema: toolInputSchema(
      {
        customerName: { type: "string" },
        items: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              menuItemId: { type: "string" },
              quantity: { type: "number" }
            },
            required: ["menuItemId", "quantity"],
            additionalProperties: false
          }
        },
        orderType: { type: "string", enum: ["pickup", "delivery"] },
        deliveryAddress: { type: "string" },
        notes: { type: "string" }
      },
      ["items", "orderType"]
    )
  },
  {
    name: "get_orders",
    description: "Owner/manager. Read today's orders summary.",
    inputSchema: toolInputSchema({})
  }
];

const normalizeToolArguments = (
  mcpToolName: string,
  args: Record<string, unknown>
): Record<string, unknown> => {
  const { contextToken: _contextToken, ...toolArgs } = args;

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

  return toolArgs;
};

const getContextToken = (args: Record<string, unknown>): string | null => {
  return typeof args.contextToken === "string" && args.contextToken.trim()
    ? args.contextToken.trim()
    : null;
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

  const contextToken = getContextToken(rawArgs);
  const tokenPayload = contextToken ? verifyHermesContextToken(contextToken) : null;

  if (!tokenPayload) {
    return {
      success: false,
      code: "MCP_CONTEXT_INVALID",
      message: "The tool context is invalid or expired."
    };
  }

  const restaurant = await Restaurant.findById(tokenPayload.restaurantId).select("+wasenderApiToken");

  if (!restaurant) {
    return {
      success: false,
      code: "RESTAURANT_NOT_FOUND",
      message: "Restaurant not found."
    };
  }

  const sender: ResolvedSender = {
    phone: tokenPayload.senderPhone,
    normalizedPhone: tokenPayload.senderPhone,
    role: tokenPayload.role,
    verified: true
  };

  return executeAgentTool(
    toolNameByMcpName[mcpToolName],
    normalizeToolArguments(mcpToolName, rawArgs),
    {
      restaurantId: tokenPayload.restaurantId,
      restaurant,
      sender,
      confirmed: true
    }
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
      tools
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
