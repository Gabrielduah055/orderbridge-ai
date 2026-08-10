import type { IOrderDocument } from "../../models/order.model";
import type { IRestaurantDocument } from "../../models/Restaurant";
import type {
  ResolvedSender,
  ToolExecutionContext,
  ToolResult
} from "../../types/agent.types";
import type { StaffOperationalState } from "./staffOperationalState.service";

export type AiProviderName = "hermes" | "openrouter";

export type AiMessageRole = "system" | "user" | "assistant" | "tool";

export interface AiToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  invalidArguments?: boolean;
  argumentParseError?: string;
}

export interface AiMessage {
  role: AiMessageRole;
  content?: string | null;
  name?: string;
  toolCallId?: string;
  toolCalls?: AiToolCall[];
}

export interface AiToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AiUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AiProviderRequest {
  messages: AiMessage[];
  tools: AiToolDefinition[];
  toolChoice?: "auto" | "none";
}

export interface AiProviderResponse {
  id?: string;
  text?: string;
  toolCalls: AiToolCall[];
  usage?: AiUsage;
  finishReason?: string;
}

export interface AiProvider {
  name: AiProviderName;
  model: string;
  complete(request: AiProviderRequest): Promise<AiProviderResponse>;
}

export interface ExecutedAgentTool {
  name: string;
  success: boolean;
  code?: string;
  message: string;
  requiresConfirmation?: boolean;
  pendingActionId?: string;
  resultOrderId?: string;
  resultOrderNumber?: string;
  resultOrderStatus?: string;
}

export interface AgentOrchestratorInput {
  restaurant: IRestaurantDocument;
  sender: ResolvedSender;
  message: string;
  requestId?: string;
  quotedMessageId?: string;
  trustedCustomerReplyContext?: TrustedCustomerReplyContext;
  staffState?: StaffOperationalState;
}

export interface TrustedCustomerReplyContext {
  workflow: "active_order";
  draftId: string;
  expectedDraftStep: string;
  responsePurpose: string;
}

export interface AgentOrchestratorResult {
  success: boolean;
  message: string;
  data?: {
    order?: IOrderDocument;
    orderEvent?: "submitted" | "confirmed" | "rejected";
    notifyOwner?: boolean;
    notifyCustomer?: boolean;
    receiptRequired?: boolean;
    pendingActionId?: string;
    [key: string]: unknown;
  };
  responseId?: string;
  errorCode?: string;
  provider: AiProviderName;
  model: string;
  executedTools: ExecutedAgentTool[];
  usage?: AiUsage;
}

export type AgentToolExecutor = (
  toolName: string,
  rawArgs: unknown,
  context: ToolExecutionContext
) => Promise<ToolResult>;
