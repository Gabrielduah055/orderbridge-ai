import type { IBusinessDocument } from "../models/business.model";
import { saveAgentConversationMessage } from "./agentConversationHistory.service";
import { runAgentOrchestrator } from "./ai/agentOrchestrator.service";
import type {
  AgentOrchestratorResult,
  CommercePageContext
} from "./ai/ai.types";
import type { ResolvedSender } from "../types/agent.types";
import type { AgentChannel } from "../types/business.types";

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

export interface CommerceChatInput {
  business: IBusinessDocument;
  channel: AgentChannel;
  conversationId: string;
  message: string;
  sender: ResolvedSender;
  source: "website_chat" | "whatsapp_chat";
  requestId?: string;
  metadata?: Record<string, unknown>;
}

interface ParsedCommerceMessage {
  customerMessage: string;
  pageContext?: CommercePageContext;
}

const kawamaProductPageMessagePattern =
  /^[^\r\n:]{1,120} catalog product page: (.{1,300}) \(product ID: ([^;\r\n]{1,200}); slug: ([^)\r\n]{1,200})\)\.\r?\nCustomer message: ([\s\S]+)$/;

const parseCommerceMessage = (
  channel: AgentChannel,
  message: string
): ParsedCommerceMessage => {
  if (channel !== "website") return { customerMessage: message };
  const match = kawamaProductPageMessagePattern.exec(message.trim());
  if (!match) return { customerMessage: message };
  const productName = match[1]?.trim();
  const productId = match[2]?.trim();
  const productSlug = match[3]?.trim();
  const customerMessage = match[4]?.trim();
  if (!productName || !productId || !productSlug || !customerMessage) {
    return { customerMessage: message };
  }
  return {
    customerMessage,
    pageContext: { productId, productSlug, productName }
  };
};

const conversationQueues = new Map<string, Promise<void>>();

export const runCommerceConversationSequentially = async <T>(
  businessId: string,
  channel: AgentChannel,
  conversationId: string,
  task: () => Promise<T>
): Promise<T> => {
  const key = `${businessId}:${channel}:${conversationId}`;
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

export const runWebsiteConversationSequentially = async <T>(
  businessId: string,
  conversationId: string,
  task: () => Promise<T>
): Promise<T> => {
  return runCommerceConversationSequentially(
    businessId,
    "website",
    conversationId,
    task
  );
};

export const handleCommerceChatMessage = async (
  input: CommerceChatInput,
  dependencies: WebsiteChatDependencies = {}
): Promise<AgentOrchestratorResult> => {
  const businessId = String(input.business._id);
  const parsedMessage = parseCommerceMessage(input.channel, input.message);
  const message = parsedMessage.customerMessage.trim().replace(/\s+/g, " ");
  const conversationId = input.conversationId.trim();
  const saveMessage = dependencies.saveMessage ?? saveAgentConversationMessage;

  return runCommerceConversationSequentially(
    businessId,
    input.channel,
    conversationId,
    async () => {
      const result = await (dependencies.runOrchestrator ?? runAgentOrchestrator)({
        business: input.business,
        businessContext: {
          businessId,
          businessName: input.business.name,
          businessType: "ecommerce",
          channel: input.channel,
          capabilities: [...input.business.capabilities],
          conversationId,
          timezone: input.business.timezone || "Africa/Accra"
        },
        sender: input.sender,
        message,
        commercePageContext: parsedMessage.pageContext,
        requestId: input.requestId
      });

      await saveMessage({
        businessId,
        businessType: "ecommerce",
        channel: input.channel,
        conversationId,
        senderRole: "customer",
        direction: "user",
        content: message,
        metadata: {
          ...input.metadata,
          ...(parsedMessage.pageContext
            ? { commercePageContext: parsedMessage.pageContext }
            : {}),
          source: input.source,
          requestId: input.requestId
        }
      });
      await saveMessage({
        businessId,
        businessType: "ecommerce",
        channel: input.channel,
        conversationId,
        senderRole: "customer",
        direction: "assistant",
        content: result.message,
        metadata: {
          ...input.metadata,
          source: "openrouter_agent",
          inputSource: input.source,
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
    }
  );
};

export const handleWebsiteChatMessage = async (
  input: WebsiteChatInput,
  dependencies: WebsiteChatDependencies = {}
): Promise<AgentOrchestratorResult> => {
  return handleCommerceChatMessage(
    {
      business: input.business,
      channel: "website",
      conversationId: input.conversationId,
      message: input.message,
      sender: {
        identityKey: `website:anonymous:${input.conversationId.trim()}`,
        phone: "",
        normalizedAddress: "",
        normalizedPhone: "",
        role: "customer",
        verified: false
      },
      source: "website_chat",
      requestId: input.requestId
    },
    dependencies
  );
};
