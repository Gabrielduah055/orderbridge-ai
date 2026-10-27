import { z } from "zod";
import {
  commerceToolRegistry,
  toolRegistry
} from "../../agent-tools/tool.registry";
import type { ToolName } from "../../agent-tools/tool.permissions";
import { isToolAllowedForContext } from "../../agent-tools/tool.permissions";
import type { SenderRole } from "../../types/agent.types";
import type { AgentPermissionContext } from "../../types/business.types";
import type { AiToolDefinition } from "./ai.types";

type JsonSchema = Record<string, unknown>;

const zodToJsonSchema = (schema: z.ZodTypeAny): JsonSchema => {
  if (schema instanceof z.ZodEffects) {
    return zodToJsonSchema(schema.innerType());
  }

  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return zodToJsonSchema(schema.unwrap());
  }

  if (schema instanceof z.ZodDefault) {
    return zodToJsonSchema(schema.removeDefault());
  }

  if (schema instanceof z.ZodString) {
    return { type: "string" };
  }

  if (schema instanceof z.ZodNumber) {
    const checks = (schema as z.ZodNumber)._def.checks ?? [];

    return {
      type: checks.some((check) => check.kind === "int") ? "integer" : "number"
    };
  }

  if (schema instanceof z.ZodBoolean) {
    return { type: "boolean" };
  }

  if (schema instanceof z.ZodEnum) {
    return {
      type: "string",
      enum: schema.options
    };
  }

  if (schema instanceof z.ZodArray) {
    const checks = (schema as z.ZodArray<z.ZodTypeAny>)._def;
    const jsonSchema: JsonSchema = {
      type: "array",
      items: zodToJsonSchema(schema.element)
    };

    for (const check of checks.minLength ? [checks.minLength] : []) {
      if (check?.value) {
        jsonSchema.minItems = check.value;
      }
    }

    for (const check of checks.maxLength ? [checks.maxLength] : []) {
      if (check?.value) {
        jsonSchema.maxItems = check.value;
      }
    }

    return jsonSchema;
  }

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      const fieldSchema = value as z.ZodTypeAny;
      properties[key] = zodToJsonSchema(fieldSchema);

      if (!fieldSchema.isOptional()) {
        required.push(key);
      }
    }

    return {
      type: "object",
      properties,
      required,
      additionalProperties: false
    };
  }

  return {
    type: "object",
    properties: {},
    additionalProperties: false
  };
};

const allAgentTools: Record<
  string,
  {
    definition: { description: string };
    schema: z.ZodTypeAny;
  }
> = {
  ...toolRegistry,
  ...commerceToolRegistry
};

export const getAgentToolDefinitionsForContext = (
  context: AgentPermissionContext
): AiToolDefinition[] => {
  return (Object.entries(allAgentTools) as Array<
    [ToolName, (typeof allAgentTools)[string]]
  >)
    .filter(([name]) => isToolAllowedForContext(name, context))
    .map(([name, tool]) => ({
      type: "function",
      function: {
        name,
        description: tool.definition.description,
        parameters: zodToJsonSchema(tool.schema)
      }
    }));
};

export const getAgentToolDefinitionsForRole = (role: SenderRole): AiToolDefinition[] => {
  return getAgentToolDefinitionsForContext({
    senderRole: role,
    businessType: "restaurant",
    channel: "whatsapp",
    capabilities: ["restaurant_operations", "restaurant_ordering", "whatsapp_chat"]
  });
};

export const getPermittedAgentToolNamesForRole = (role: SenderRole): Set<string> => {
  return new Set(getAgentToolDefinitionsForRole(role).map((tool) => tool.function.name));
};

export const getPermittedAgentToolNamesForContext = (
  context: AgentPermissionContext
): Set<string> => {
  return new Set(getAgentToolDefinitionsForContext(context).map((tool) => tool.function.name));
};
