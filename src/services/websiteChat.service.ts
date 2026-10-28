import type { IBusinessDocument } from "../models/business.model";
import { saveAgentConversationMessage } from "./agentConversationHistory.service";
import { runAgentOrchestrator } from "./ai/agentOrchestrator.service";
import type { AgentOrchestratorResult } from "./ai/ai.types";

export interface WebsiteChatInput {
  business: IBusinessDocument;
  conversationId: string;
  message: string;
  requestId?: string;
}

export interface WebsiteChatDependencies {
  runOrchestrator?: typeof runAgentOrchestrator;
  saveMessage?: typeof saveAgentConversationMessage;
}

const conversationQueues = new Map<string, Promise<void>>();

export const runWebsiteConversationSequentially = async <T>(
  businessId: string,
  conversationId: string,
  task: () => Promise<T>
): Promise<T> => {
  const key = `${businessId}:website:${conversationId}`;
  const previous = conversationQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  const cleanup = next
    .then(() => undefined, () => undefined)
    .finally(() => {
      if (conversationQueues.get(key) === cleanup) conversationQueues.delete(key);
    });
  conversationQueues.set(key, cleanup);
  return next;
};

export const handleWebsiteChatMessage = async (
  input: WebsiteChatInput,
  dependencies: WebsiteChatDependencies = {}
): Promise<AgentOrchestratorResult> => {
  const businessId = String(input.business._id);
  const message = input.message.trim().replace(/\s+/g, " ");
  const conversationId = input.conversationId.trim();
  const saveMessage = dependencies.saveMessage ?? saveAgentConversationMessage;

  return runWebsiteConversationSequentially(businessId, conversationId, async () => {
    const result = await (dependencies.runOrchestrator ?? runAgentOrchestrator)({
      business: input.business,
      businessContext: {
        businessId,
        businessName: input.business.name,
        businessType: "ecommerce",
        channel: "website",
        capabilities: [...input.business.capabilities],
        conversationId,
        timezone: input.business.timezone || "Africa/Accra"
      },
      sender: {
        identityKey: `website:anonymous:${conversationId}`,
        phone: "",
        normalizedAddress: "",
        normalizedPhone: "",
        role: "customer",
        verified: false
      },
      message,
      requestId: input.requestId
    });

    await saveMessage({
      businessId,
      businessType: "ecommerce",
      channel: "website",
      conversationId,
      senderRole: "customer",
      direction: "user",
      content: message,
      metadata: { source: "website_chat", requestId: input.requestId }
    });
    await saveMessage({
      businessId,
      businessType: "ecommerce",
      channel: "website",
      conversationId,
      senderRole: "customer",
      direction: "assistant",
      content: result.message,
      metadata: {
        source: "openrouter_agent",
        provider: result.provider,
        model: result.model,
        success: result.success,
        responseId: result.responseId,
        executedTools: result.executedTools,
        usage: result.usage,
        commerceGrounding: result.data?.commerceGrounding
      }
    });

    return result;
  });
};
