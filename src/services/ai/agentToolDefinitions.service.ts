import { z } from "zod";
import { toolRegistry } from "../../agent-tools/tool.registry";
import type { ToolName } from "../../agent-tools/tool.permissions";
import type { SenderRole } from "../../types/agent.types";
import type { AiToolDefinition } from "./ai.types";

type JsonSchema = Record<string, unknown>;

const zodToJsonSchema = (schema: z.ZodTypeAny): JsonSchema => {
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

export const getAgentToolDefinitionsForRole = (role: SenderRole): AiToolDefinition[] => {
  return (Object.entries(toolRegistry) as Array<[ToolName, (typeof toolRegistry)[ToolName]]>)
    .filter(([, tool]) => tool.roles.includes(role))
    .map(([name, tool]) => ({
      type: "function",
      function: {
        name,
        description: tool.definition.description,
        parameters: zodToJsonSchema(tool.schema)
      }
    }));
};

export const getPermittedAgentToolNamesForRole = (role: SenderRole): Set<string> => {
  return new Set(getAgentToolDefinitionsForRole(role).map((tool) => tool.function.name));
};
