import {
  saveAgentConversationMessage
} from "./agentConversationHistory.service";
import { cancelPendingOrderItemClarifications } from "./agentClarification.service";
import {
  cancelPendingToolAction,
  cancelPendingToolActionById,
  executeAgentTool,
  executeConfirmedPendingToolAction,
  findLatestPendingToolAction,
  findPendingToolActions
} from "../agent-tools/tool.executor";
import { getAiProviderName, getOpenRouterConfig } from "./ai/ai.config";
import { runAgentOrchestrator } from "./ai/agentOrchestrator.service";
import { handleLegacyCustomerMessage } from "./agentCustomer.service";
import { isHermesAgentConfigured, sendHermesAgentMessage } from "./hermesAgent.service";
import { PendingAgentAction } from "../models/pendingAgentAction.model";
import { OutboundMessage } from "../models/outboundMessage.model";
import {
  handleSavedOwnerSelectionReply,
  handleUnquotedOwnerOrderDecision,
  parseOwnerSelectionReply,
  parseSimpleOwnerDecision,
  reconcileAwaitingOwnerRejectionSelection,
  requestOwnerOrderRejectionReason,
  resolveQuotedOwnerOrderDecision
} from "./ownerOrderResolution.service";
import { resolveSenderIdentity } from "./senderIdentity.service";
import {
  extractMenuItemNameFromImageRetargetReply,
  handlePendingMenuItemImageReply,
  isMenuItemImageCancellationMessage,
  isMenuItemImageConfirmationMessage,
  shouldHandlePendingMenuItemImageReply,
  rememberMenuItemImageRequest
} from "./menuItemImageWorkflow.service";
import {
  handleCustomerMarketingPreferenceCommand,
  setCustomerMarketingPreference
} from "./customerMarketingPreference.service";
import {
  getPendingMarketingConsentContext,
  parseMarketingConsentResponse,
  recordMarketingConsentPromptResponse
} from "./customerMarketingOnboarding.service";
import {
  handleOrderFeedbackCustomerResponse,
  isExplicitNaturalOrderFeedback,
  loadActiveOrderCheckInState,
  resolveQuotedOrderFeedbackOrderId,
  type ActiveOrderCheckInView,
  type HandleOrderFeedbackResponseResult
} from "./orderFeedback.service";
import type {
  RestaurantAgentMessageInput,
  RestaurantAgentResponse,
  SenderRole
} from "../types/agent.types";
import type {
  AgentOrchestratorResult,
  TrustedCustomerReplyContext
} from "./ai/ai.types";
import {
  buildStaffOperationalState,
  createEmptyStaffOperationalState
} from "./ai/staffOperationalState.service";
import { findActiveDraft } from "./orderDraft.service";
import type { CustomerSessionStep } from "../models/customerSession.model";

const temporaryHermesErrorMessage =
  "I'm having trouble reaching the restaurant assistant right now. Please try again in a few minutes.";
const temporaryAgentErrorMessage =
  "I'm having trouble reaching the restaurant system right now. Please try again shortly.";
const customerMutationToolNames = new Set([
  "start_order",
  "add_order_item_by_name",
  "remove_order_item_by_name",
  "update_order_item_quantity",
  "update_order_draft",
  "confirm_order_draft",
  "cancel_order_draft",
  "cancel_order",
  "respond_to_order_check_in"
]);

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

const explicitCustomerClarificationResetMessages = new Set([
  "start over",
  "restart",
  "send me the menu",
  "show me the menu"
]);

export const isExplicitCustomerClarificationResetMessage = (
  message: string
): boolean => {
  const normalized = normalizeText(message)
    .toLowerCase()
    .replace(/[.!?]+$/, "")
    .replace(/^please\s+/, "");

  return explicitCustomerClarificationResetMessages.has(normalized);
};

export const isExactOrderCheckInReply = (message: string): boolean =>
  /^[123][.!]?$/.test(normalizeText(message));

export const isAmbiguousCustomerWorkflowReply = (message: string): boolean =>
  /^(?:[123][.!]?|yes|yh|yea|yeah|yep|yup|ok|okay|sure|alright|no|nope|nah)$/i.test(
    normalizeText(message)
  );

const competingCustomerOrderSteps = new Set<CustomerSessionStep>([
  "choosing_items",
  "selecting_item_from_category",
  "collecting_quantity",
  "choosing_order_type",
  "collecting_address",
  "collecting_name",
  "awaiting_delivery_fee",
  "confirming_order"
]);

export const hasCompetingCustomerOrderWorkflow = (
  draft: { currentStep: CustomerSessionStep } | null
): boolean => Boolean(draft && competingCustomerOrderSteps.has(draft.currentStep));

const activeOrderQuestionPurposeByStep: Partial<
  Record<CustomerSessionStep, string>
> = {
  collecting_quantity: "quantity_clarification",
  choosing_order_type: "order_type_question",
  collecting_address: "address_question",
  collecting_name: "name_question"
};

export const resolveQuotedActiveOrderReplyContext = async (
  restaurantId: string,
  customerPhone: string,
  quotedMessageId: string | undefined,
  draft: Awaited<ReturnType<typeof findActiveDraft>>
): Promise<TrustedCustomerReplyContext | null> => {
  const providerMessageId = quotedMessageId?.trim();
  const responsePurpose = draft
    ? activeOrderQuestionPurposeByStep[draft.currentStep]
    : undefined;

  if (!providerMessageId || !draft || !responsePurpose) {
    return null;
  }

  const draftId = String(draft._id);
  const outbound = await OutboundMessage.findOne({
    restaurantId,
    to: customerPhone,
    status: "sent",
    providerMessageId,
    "metadata.kind": "customer_agent_question",
    "metadata.customerPhone": customerPhone,
    "metadata.draftId": draftId,
    "metadata.expectedDraftStep": draft.currentStep,
    "metadata.responsePurpose": responsePurpose
  })
    .sort({ sentAt: -1 })
    .select("_id");

  return outbound
    ? {
        workflow: "active_order",
        draftId,
        expectedDraftStep: draft.currentStep,
        responsePurpose
      }
    : null;
};

const buildCompetingCustomerWorkflowClarification = (
  message: string,
  draft: Awaited<ReturnType<typeof findActiveDraft>>,
  checkIns: ActiveOrderCheckInView[]
): string => {
  const feedbackReferences = checkIns.map((checkIn) => checkIn.orderNumber);
  const feedbackLabel =
    feedbackReferences.length === 1
      ? feedbackReferences[0]
      : feedbackReferences.join(" or ");
  const currentOrderLabel =
    draft?.currentStep === "collecting_quantity" &&
    draft.pendingMenuItemName?.trim()
      ? `the quantity for your current ${draft.pendingMenuItemName} order`
      : "your current order";

  return `Just to make sure — is “${normalizeText(message)}” about ${currentOrderLabel}, or are you replying about ${feedbackLabel}?`;
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

const hasExplicitImageViewCue = (message: string): boolean => {
  return /\b(photo|image|picture)\b|\bwhat\s+does\b.+\blook\s+like\b/i.test(message);
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
    /^(yes|yea|yeah|yep|yup|yh|sure|correct|confirm|confirmed|okay|ok)\b/.test(
      normalized
    ) ||
    /^\d+$/.test(normalized) ||
    /^(yes|yeah|ok|okay)\s+\d+$/.test(normalized) ||
    /^(ok|okay|alright)\s+(go ahead|proceed|save|confirm|update|change|do it)\b/.test(normalized) ||
    /^(go ahead|proceed|save it|do it|add it|use it)\b/.test(normalized) ||
    /^(update|change)\s+(it|that|the item|the price|this)\b/.test(normalized)
  );
};

export const parseOwnerOrderDecision = (
  message: string
): { decision: "accept" | "reject"; orderReference: string; reason?: string } | null => {
  const normalized = message.trim();
  const match = normalized.match(
    /^(?:accept|confirm(?:\s+order)?|reject|cancel)\s+(?:order\s+)?(ORD-[A-Za-z0-9-]+|[a-f0-9]{24})(?:(?:\s*[,;:\-—]\s*|\s+because\s+|\s+)(.+))?$/i
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

type CurrentStaffConfirmation =
  | { kind: "image"; pendingActionId: string }
  | { kind: "tool"; pendingActionId: string }
  | null;

const getCreatedAtTime = (value?: unknown): number => {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
};

export const resolveCurrentStaffConfirmation = (
  imageWorkflow: Awaited<
    ReturnType<typeof buildStaffOperationalState>
  >["imageWorkflow"],
  latestToolAction?: { _id?: unknown; createdAt?: unknown } | null
): CurrentStaffConfirmation => {
  if (!imageWorkflow && !latestToolAction) {
    return null;
  }

  if (!imageWorkflow) {
    return {
      kind: "tool",
      pendingActionId: String(latestToolAction?._id)
    };
  }

  if (!latestToolAction) {
    return {
      kind: "image",
      pendingActionId: imageWorkflow.pendingActionId
    };
  }

  return getCreatedAtTime(imageWorkflow.createdAt) >
    getCreatedAtTime(latestToolAction.createdAt)
    ? {
        kind: "image",
        pendingActionId: imageWorkflow.pendingActionId
      }
    : {
        kind: "tool",
        pendingActionId: String(latestToolAction._id)
      };
};

const hasExplicitImageWorkflowLanguage = (message: string): boolean =>
  Boolean(extractMenuItemNameFromImageRetargetReply(message)) ||
  /\b(?:image|photo|picture)\b/i.test(message);

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

export const shouldUseAiFirstStaffTextRouting = (
  role: ReturnType<typeof resolveSenderIdentity>["role"],
  aiProviderName: string
): role is "owner" | "manager" =>
  aiProviderName === "openrouter" && (role === "owner" || role === "manager");

export interface RestaurantAgentRoutingDependencies {
  runOrchestrator?: typeof runAgentOrchestrator;
  handleLegacyCustomerMessage?: typeof handleLegacyCustomerMessage;
  buildStaffState?: typeof buildStaffOperationalState;
  handlePendingImageReply?: typeof handlePendingMenuItemImageReply;
  rememberImageRequest?: typeof rememberMenuItemImageRequest;
  parseOrderDecision?: typeof parseOwnerOrderDecision;
  parseSimpleDecision?: typeof parseSimpleOwnerDecision;
  handleSavedSelection?: typeof handleSavedOwnerSelectionReply;
  reconcileAwaitingSelection?: typeof reconcileAwaitingOwnerRejectionSelection;
  handleUnquotedDecision?: typeof handleUnquotedOwnerOrderDecision;
  requestRejectionReason?: typeof requestOwnerOrderRejectionReason;
  resolveQuotedDecision?: typeof resolveQuotedOwnerOrderDecision;
  executeTool?: typeof executeAgentTool;
  findLatestPendingAction?: typeof findLatestPendingToolAction;
  findPendingActions?: typeof findPendingToolActions;
  executeConfirmedAction?: typeof executeConfirmedPendingToolAction;
  cancelPendingAction?: typeof cancelPendingToolAction;
  cancelPendingActionById?: typeof cancelPendingToolActionById;
  cancelCustomerClarifications?: typeof cancelPendingOrderItemClarifications;
  handleCustomerFeedback?: typeof handleOrderFeedbackCustomerResponse;
  findCustomerDraft?: typeof findActiveDraft;
  loadCustomerCheckIns?: typeof loadActiveOrderCheckInState;
  resolveQuotedCustomerFeedback?: typeof resolveQuotedOrderFeedbackOrderId;
  resolveQuotedCustomerActiveOrder?: typeof resolveQuotedActiveOrderReplyContext;
  loadMarketingConsentContext?: typeof getPendingMarketingConsentContext;
  setMarketingPreference?: typeof setCustomerMarketingPreference;
  recordMarketingConsentResponse?: typeof recordMarketingConsentPromptResponse;
}

export const hasMeaningfulAgentToolActivity = (
  executedTools: AgentOrchestratorResult["executedTools"]
): boolean =>
  executedTools.some((tool) => tool.success || Boolean(tool.pendingActionId));

type RequiredImageWorkflowTool =
  | "assign_pending_image_to_menu_item"
  | "confirm_pending_image_assignment"
  | "cancel_pending_image_assignment";

const getRequiredImageWorkflowTool = (
  imageWorkflow: Awaited<ReturnType<typeof buildStaffOperationalState>>["imageWorkflow"],
  message: string
): RequiredImageWorkflowTool | null => {
  if (
    !imageWorkflow ||
    !shouldHandlePendingMenuItemImageReply(imageWorkflow.stage, message)
  ) {
    return null;
  }

  if (
    imageWorkflow.stage === "awaiting_confirmation" &&
    extractMenuItemNameFromImageRetargetReply(message)
  ) {
    return "assign_pending_image_to_menu_item";
  }

  if (isMenuItemImageCancellationMessage(message)) {
    return "cancel_pending_image_assignment";
  }

  if (
    imageWorkflow.stage === "awaiting_confirmation" &&
    isMenuItemImageConfirmationMessage(message)
  ) {
    return "confirm_pending_image_assignment";
  }

  return imageWorkflow.stage === "awaiting_item" ||
    imageWorkflow.stage === "awaiting_confirmation"
    ? "assign_pending_image_to_menu_item"
    : null;
};

const hasMeaningfulNamedToolActivity = (
  executedTools: AgentOrchestratorResult["executedTools"],
  toolName: string
): boolean =>
  executedTools.some(
    (tool) =>
      tool.name === toolName &&
      (tool.success || Boolean(tool.pendingActionId))
  );

type StaffOrderMutationKind = "accept" | "reject" | "complete" | "progress";

export interface StaffOrderMutationIntent {
  kind: StaffOrderMutationKind;
  requiredTool: "confirm_order" | "reject_order" | "update_order_status";
  orderReference?: string;
  reason?: string;
  targetStatus?: "preparing" | "ready" | "out_for_delivery" | "completed";
  expectedOrderIds?: string[];
  pendingSelectionActionId?: string;
  awaitingRejectionReason?: boolean;
  missingReason: boolean;
  ambiguous: boolean;
}

const cleanInlineRejectionReason = (value?: string): string | undefined => {
  const normalized = value
    ?.trim()
    .replace(/^[,;:\s\-—]+/, "")
    .replace(/^because\s+/i, "")
    .trim();

  return normalized && normalized.length >= 3 ? normalized : undefined;
};

export const getStaffOrderMutationIntent = (
  staffState: Awaited<ReturnType<typeof buildStaffOperationalState>>,
  message: string
): StaffOrderMutationIntent | null => {
  const normalized = normalizeText(message);
  const explicitDecision = parseOwnerOrderDecision(normalized);
  const selection = staffState.recentReferences.orderSelection;
  let kind: StaffOrderMutationKind | null = explicitDecision?.decision ?? null;
  let orderReference = explicitDecision?.orderReference;
  let reason = cleanInlineRejectionReason(explicitDecision?.reason);
  let selectedCandidateIds: string[] | undefined;
  let targetStatus: StaffOrderMutationIntent["targetStatus"];

  if (!kind && selection?.decision === "reject" && selection.awaitingReason) {
    return {
      kind: "reject",
      requiredTool: "reject_order",
      expectedOrderIds: selection.candidates.map((candidate) => candidate.id),
      pendingSelectionActionId: selection.pendingActionId,
      awaitingRejectionReason: true,
      missingReason: false,
      ambiguous: false
    };
  }

  if (!kind && selection && !selection.awaitingReason) {
    const selectionReply = parseOwnerSelectionReply(
      normalized,
      selection.candidates.length
    );

    if (selectionReply && selectionReply.type !== "cancel") {
      kind = selection.decision;
      reason = selection.rejectionReason;
      selectedCandidateIds =
        selectionReply.type === "all"
          ? selection.candidates.map((candidate) => candidate.id)
          : selectionReply.indexes
              .map((index) => selection.candidates[index - 1]?.id)
              .filter((id): id is string => Boolean(id));
    }
  }

  if (!kind) {
    const acceptMatch = normalized.match(
      /^(?:accept|confirm)(?:\s+(?:it|this|that|that one|this order|the order))?[.!]?$/i
    );
    const rejectMatch = normalized.match(
      /^(?:reject|decline)(?:\s+(?:it|this|that|that one|this order|the order))?(?:(?:\s+because\s+|\s*[,;:\-—]\s*)(.+))?[.!]?$/i
    );
    const cannotFulfilMatch = normalized.match(
      /^(?:can'?t|cannot)\s+fulfil(?:l)?(?:\s+(?:it|this|that|that order|this order))?(?:(?:\s+because\s+|\s*[,;:\-—]\s*)(.+))?[.!]?$/i
    );

    if (acceptMatch) {
      kind = "accept";
    } else if (rejectMatch || cannotFulfilMatch) {
      kind = "reject";
      reason = cleanInlineRejectionReason(
        rejectMatch?.[1] ?? cannotFulfilMatch?.[1]
      );
    }
  }

  if (!kind) {
    const completionWithReference = normalized.match(
      /^(?:mark\s+)?(?:order\s+)?(ORD-[A-Za-z0-9-]+|[a-f0-9]{24})(?:\s+as)?\s+(?:done|completed|delivered)[.!]?$/i
    );
    const simpleCompletion = /^(?:done|order done|mark (?:it|this|that|that one|this order|the order) (?:done|completed)|(?:this|that|the) order is done|delivered|completed)[.!]?$/i.test(
      normalized
    );

    if (completionWithReference || simpleCompletion) {
      kind = "complete";
      targetStatus = "completed";
      orderReference = completionWithReference?.[1];
    }
  }

  if (!kind) {
    const progressWithReference = normalized.match(
      /^(?:mark|set|update)?\s*(?:order\s+)?(ORD-[A-Za-z0-9-]+|[a-f0-9]{24})(?:\s+(?:as|to|is))?\s+(preparing|ready|out for delivery)[.!]?$/i
    );
    const simpleProgress = normalized.match(
      /^(?:mark|set|update)\s+(?:it|this|that|that one|this order|the order)(?:\s+(?:as|to))?\s+(preparing|ready|out for delivery)[.!]?$/i
    );
    const rawStatus = progressWithReference?.[2] ?? simpleProgress?.[1];

    if (rawStatus) {
      kind = "progress";
      targetStatus = rawStatus.toLowerCase().replace(/\s+/g, "_") as
        | "preparing"
        | "ready"
        | "out_for_delivery";
      orderReference = progressWithReference?.[1];
    }
  }

  if (!kind) {
    return null;
  }

  if (!orderReference) {
    const quotedOrder = staffState.recentReferences.quotedOrder;
    const selectionCandidates = selection?.candidates ?? [];
    const relevantOrders =
      kind === "complete" || kind === "progress"
        ? staffState.orders.recentActive
        : staffState.orders.freshPending;

    if (quotedOrder?.id) {
      orderReference = quotedOrder.id;
    } else if (selectedCandidateIds?.length === 1) {
      orderReference = selectedCandidateIds[0];
    } else if (selectedCandidateIds && selectedCandidateIds.length > 1) {
      return {
        kind,
        requiredTool: kind === "accept" ? "confirm_order" : "reject_order",
        reason,
        expectedOrderIds: selectedCandidateIds,
        missingReason: kind === "reject" && !reason,
        ambiguous: false
      };
    } else if (selectionCandidates.length === 1) {
      orderReference = selectionCandidates[0].id;
    } else if (relevantOrders.length === 1) {
      orderReference = relevantOrders[0].id;
    } else {
      return {
        kind,
        requiredTool:
          kind === "accept"
            ? "confirm_order"
            : kind === "reject"
              ? "reject_order"
              : "update_order_status",
        reason,
        targetStatus,
        missingReason: kind === "reject" && !reason,
        ambiguous: relevantOrders.length > 1 || selectionCandidates.length > 1
      };
    }
  }

  return {
    kind,
    requiredTool:
      kind === "accept"
        ? "confirm_order"
        : kind === "reject"
          ? "reject_order"
          : "update_order_status",
    orderReference,
    reason,
    targetStatus,
    missingReason: kind === "reject" && !reason,
    ambiguous: false
  };
};

const hasSuccessfulOrderMutationTool = (
  intent: StaffOrderMutationIntent,
  result: AgentOrchestratorResult
): boolean => {
  if (
    (intent.expectedOrderIds?.length ?? 0) > 1 &&
    !intent.awaitingRejectionReason
  ) {
    // The saved selection closes the pending workflow and safely replays any
    // idempotent mutation the AI may already have completed. In particular, one
    // successful tool call must never consume a multi-order selection turn.
    return false;
  }

  if (intent.awaitingRejectionReason) {
    const expectedOrderIds = intent.expectedOrderIds ?? [];

    return (
      expectedOrderIds.length > 0 &&
      expectedOrderIds.every((orderId) =>
        result.executedTools.some(
          (tool) =>
            tool.name === "reject_order" &&
            tool.success &&
            tool.resultOrderId === orderId
        )
      )
    );
  }

  const matchingTool = result.executedTools.find(
    (tool) => tool.name === intent.requiredTool && tool.success
  );

  if (!matchingTool) {
    return false;
  }

  if (
    intent.orderReference &&
    intent.orderReference !== matchingTool.resultOrderId &&
    intent.orderReference.toLowerCase() !==
      matchingTool.resultOrderNumber?.toLowerCase()
  ) {
    return false;
  }

  return (
    intent.requiredTool !== "update_order_status" ||
    matchingTool.resultOrderStatus === intent.targetStatus
  );
};

const getSuccessfulAwaitingRejectionOrderIds = (
  intent: StaffOrderMutationIntent,
  result: AgentOrchestratorResult
): string[] => {
  const expectedOrderIds = intent.expectedOrderIds ?? [];

  return expectedOrderIds.filter((orderId) =>
    result.executedTools.some(
      (tool) =>
        tool.name === "reject_order" &&
        tool.success &&
        tool.resultOrderId === orderId
    )
  );
};

const looksLikeRejectionCompletionClaim = (message: string): boolean => {
  const normalized = normalizeText(message).toLowerCase();

  if (/^(?:done|completed|successfully done)[.!]*$/.test(normalized)) {
    return true;
  }

  if (!/\b(?:reject(?:ed|ion)?|declin(?:ed|e)?)\b/.test(normalized)) {
    return false;
  }

  if (
    /\b(?:no order|nothing)\b.{0,30}\breject/.test(normalized) ||
    /\b(?:not|never)\b.{0,15}\breject/.test(normalized) ||
    /\breject(?:ed|ion)?\b.{0,15}\b(?:not|never|yet)\b/.test(normalized) ||
    /\b(?:can|could|should|would|will|ready to|want me to)\b.{0,25}\b(?:reject|decline)\b/.test(
      normalized
    ) ||
    normalized.endsWith("?")
  ) {
    return false;
  }

  return true;
};

const buildAwaitingRejectionSafetyMessage = (
  candidates: Array<{ id: string; orderNumber?: string }>,
  successfulOrderIds: string[],
  remainingOrderIds: string[]
): string => {
  const candidateMap = new Map(
    candidates.map((candidate) => [
      candidate.id,
      candidate.orderNumber || candidate.id
    ])
  );
  const labelsFor = (orderIds: string[]): string =>
    orderIds.map((orderId) => candidateMap.get(orderId) || orderId).join(", ");

  if (successfulOrderIds.length > 0 && remainingOrderIds.length > 0) {
    return `I confirmed the rejection for ${labelsFor(successfulOrderIds)}, but ${labelsFor(
      remainingOrderIds
    )} is still pending. Please provide the rejection reason again so I can safely retry the remaining order${
      remainingOrderIds.length === 1 ? "" : "s"
    }.`;
  }

  if (successfulOrderIds.length > 0) {
    return "The rejection tool succeeded, but I couldn't safely close the pending rejection workflow. Please provide the rejection reason again so I can retry safely.";
  }

  const expectedOrderIds = candidates.map((candidate) => candidate.id);
  const reference = labelsFor(expectedOrderIds);

  return `I haven't confirmed the rejection${reference ? ` for ${reference}` : ""}. Please provide the rejection reason again so I can retry safely.`;
};

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
      availableOnly: sender.role === "customer"
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
    data: imageUrl
      ? {
          menuItemImage: {
            imageUrl,
            caption: resolvedName,
            source: "menu_item_record"
          }
        }
      : undefined,
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
  sender: ReturnType<typeof resolveSenderIdentity>,
  legacyHandler: typeof handleLegacyCustomerMessage = handleLegacyCustomerMessage
): Promise<RestaurantAgentResponse> => {
  const restaurantId = String(input.restaurant._id);
  console.warn("[customerAgent] legacy fallback used", {
    restaurantId,
    senderRole: sender.role
  });
  const result = await legacyHandler({
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
  input: RestaurantAgentMessageInput,
  dependencies: RestaurantAgentRoutingDependencies = {}
): Promise<RestaurantAgentResponse> => {
  const restaurantId = String(input.restaurant._id);
  const resolvedSender = resolveSenderIdentity(input.restaurant, input.senderPhone);
  const sender =
    resolvedSender.role === "customer" && input.customerName?.trim()
      ? { ...resolvedSender, name: input.customerName.trim() }
      : resolvedSender;
  const message = normalizeText(input.message);
  const aiProviderName = getAiProviderName();
  const openRouterConfig = getOpenRouterConfig();
  const customerOpenRouterEnabled = shouldUseOpenRouterCustomerAgent(
    aiProviderName,
    openRouterConfig.customerAgentEnabled
  );
  const runOrchestrator = dependencies.runOrchestrator ?? runAgentOrchestrator;
  const legacyCustomerHandler =
    dependencies.handleLegacyCustomerMessage ?? handleLegacyCustomerMessage;
  const cancelCustomerClarifications =
    dependencies.cancelCustomerClarifications ?? cancelPendingOrderItemClarifications;
  const handleCustomerFeedback =
    dependencies.handleCustomerFeedback ?? handleOrderFeedbackCustomerResponse;
  const findCustomerDraft = dependencies.findCustomerDraft ?? findActiveDraft;
  const loadCustomerCheckIns =
    dependencies.loadCustomerCheckIns ?? loadActiveOrderCheckInState;
  const resolveQuotedCustomerFeedback =
    dependencies.resolveQuotedCustomerFeedback ??
    resolveQuotedOrderFeedbackOrderId;
  const resolveQuotedCustomerActiveOrder =
    dependencies.resolveQuotedCustomerActiveOrder ??
    resolveQuotedActiveOrderReplyContext;
  const loadMarketingConsentContext =
    dependencies.loadMarketingConsentContext ??
    getPendingMarketingConsentContext;
  const applyMarketingPreference =
    dependencies.setMarketingPreference ?? setCustomerMarketingPreference;
  const recordMarketingConsentResponse =
    dependencies.recordMarketingConsentResponse ??
    recordMarketingConsentPromptResponse;
  const buildStaffState =
    dependencies.buildStaffState ?? buildStaffOperationalState;
  const handlePendingImageReply =
    dependencies.handlePendingImageReply ?? handlePendingMenuItemImageReply;
  const rememberImageRequest =
    dependencies.rememberImageRequest ?? rememberMenuItemImageRequest;
  const parseOrderDecision =
    dependencies.parseOrderDecision ?? parseOwnerOrderDecision;
  const parseSimpleDecision =
    dependencies.parseSimpleDecision ?? parseSimpleOwnerDecision;
  const handleSavedSelection =
    dependencies.handleSavedSelection ?? handleSavedOwnerSelectionReply;
  const reconcileAwaitingSelection =
    dependencies.reconcileAwaitingSelection ??
    reconcileAwaitingOwnerRejectionSelection;
  const handleUnquotedDecision =
    dependencies.handleUnquotedDecision ?? handleUnquotedOwnerOrderDecision;
  const requestRejectionReason =
    dependencies.requestRejectionReason ?? requestOwnerOrderRejectionReason;
  const resolveQuotedDecision =
    dependencies.resolveQuotedDecision ?? resolveQuotedOwnerOrderDecision;
  const executeTool = dependencies.executeTool ?? executeAgentTool;
  const findLatestPendingAction =
    dependencies.findLatestPendingAction ?? findLatestPendingToolAction;
  const findPendingActions =
    dependencies.findPendingActions ?? findPendingToolActions;
  const executeConfirmedAction =
    dependencies.executeConfirmedAction ?? executeConfirmedPendingToolAction;
  const cancelPendingAction =
    dependencies.cancelPendingAction ?? cancelPendingToolAction;
  const cancelPendingActionById =
    dependencies.cancelPendingActionById ?? cancelPendingToolActionById;

  console.info("Restaurant agent sender resolved", {
    restaurantId,
    senderRole: sender.role,
    verified: sender.verified
  });

  let trustedCustomerReplyContext: TrustedCustomerReplyContext | undefined;

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

    const exactCheckInReply = isExactOrderCheckInReply(message);
    const ambiguousShortReply = isAmbiguousCustomerWorkflowReply(message);
    const consentResponse = parseMarketingConsentResponse(message);
    const genericConsentResponse = Boolean(
      consentResponse && !consentResponse.explicitlyMentionsMarketing
    );
    const explicitNaturalFeedback = isExplicitNaturalOrderFeedback(message);
    let activeDraft: Awaited<ReturnType<typeof findActiveDraft>> = null;
    let activeCheckIns: ActiveOrderCheckInView[] = [];
    let marketingConsentContext = {
      pending: false,
      quotedRequest: false,
      genericResponseWindowOpen: false
    };
    let workflowStateLoadFailed = false;

    if (ambiguousShortReply || consentResponse) {
      try {
        [activeDraft, activeCheckIns, marketingConsentContext] = await Promise.all([
          findCustomerDraft(restaurantId, sender.normalizedPhone),
          loadCustomerCheckIns(restaurantId, sender.normalizedPhone),
          consentResponse
            ? loadMarketingConsentContext(
                restaurantId,
                sender.normalizedPhone,
                input.quotedMessageId
              )
            : Promise.resolve({
                pending: false,
                quotedRequest: false,
                genericResponseWindowOpen: false
              })
        ]);
      } catch (error) {
        workflowStateLoadFailed = true;
        console.error("[customerAgent] competing workflow check failed", {
          restaurantId,
          errorType: error instanceof Error ? error.name : "UnknownError"
        });
      }
    }

    const competingOrderWorkflow =
      hasCompetingCustomerOrderWorkflow(activeDraft);
    const hasActiveFeedbackWorkflow = activeCheckIns.length > 0;
    let trustedQuotedOrderId: string | null = null;

    const hasTrustedGenericConsentContext = Boolean(
      marketingConsentContext.pending &&
        (marketingConsentContext.quotedRequest ||
          marketingConsentContext.genericResponseWindowOpen)
    );

    if (
      consentResponse &&
      (consentResponse.explicitlyMentionsMarketing ||
        hasTrustedGenericConsentContext)
    ) {
      const hasCompetingWorkflow =
        competingOrderWorkflow || hasActiveFeedbackWorkflow;
      const needsClarification =
        !consentResponse.explicitlyMentionsMarketing &&
        !marketingConsentContext.quotedRequest &&
        (workflowStateLoadFailed || hasCompetingWorkflow);

      if (needsClarification) {
        const clarificationMessage = `Just to make sure — is that ${consentResponse.command === "opt_in" ? "yes" : "no"} for your current order, or would you like to receive ${input.restaurant.name} offers and discounts?`;

        await saveAgentConversationMessage({
          restaurantId,
          senderPhone: sender.normalizedPhone,
          senderRole: sender.role,
          direction: "user",
          content: message,
          metadata: {
            source: "deterministic_marketing_consent_clarification",
            inboundEventId: input.inboundEventId
          }
        });
        await saveAgentConversationMessage({
          restaurantId,
          senderPhone: sender.normalizedPhone,
          senderRole: sender.role,
          direction: "assistant",
          content: clarificationMessage,
          metadata: {
            source: "deterministic_marketing_consent_clarification",
            activeDraftStep: activeDraft?.currentStep,
            activeFeedbackOrderCount: activeCheckIns.length
          }
        });

        return {
          success: true,
          message: clarificationMessage,
          data: {
            workflowClarificationRequired: true,
            marketingConsentClarificationRequired: true
          },
          source: "legacy_customer",
          sender
        };
      }

      const profile = await applyMarketingPreference(
        restaurantId,
        sender.normalizedPhone,
        consentResponse.command,
        "customer_message"
      );
      if (hasTrustedGenericConsentContext) {
        try {
          await recordMarketingConsentResponse(
            restaurantId,
            sender.normalizedPhone,
            consentResponse.command
          );
        } catch (error) {
          console.error("[customerAgent] consent response audit failed", {
            restaurantId,
            errorType: error instanceof Error ? error.name : "UnknownError"
          });
        }
      }
      const preferenceMessage =
        consentResponse.command === "opt_in"
          ? `Done. ${input.restaurant.name} can occasionally send you offers and updates here. Reply STOP anytime to stop them.`
          : `No problem. You won't receive promotional messages from ${input.restaurant.name}. Your normal order updates and receipts will still work.`;

      await saveAgentConversationMessage({
        restaurantId,
        senderPhone: sender.normalizedPhone,
        senderRole: sender.role,
        direction: "user",
        content: message,
        metadata: {
          source: "deterministic_marketing_consent_response",
          command: consentResponse.command,
          quotedRequest: marketingConsentContext.quotedRequest
        }
      });
      await saveAgentConversationMessage({
        restaurantId,
        senderPhone: sender.normalizedPhone,
        senderRole: sender.role,
        direction: "assistant",
        content: preferenceMessage,
        metadata: {
          source: "deterministic_marketing_consent_response",
          command: consentResponse.command,
          quotedRequest: marketingConsentContext.quotedRequest
        }
      });

      return {
        success: true,
        message: preferenceMessage,
        data: {
          marketingPreference: consentResponse.command,
          marketingConsent: profile.marketingConsent,
          isOptedOut: profile.isOptedOut
        },
        source: "legacy_customer",
        sender
      };
    }

    if (
      input.quotedMessageId &&
      (explicitNaturalFeedback ||
        (ambiguousShortReply && hasActiveFeedbackWorkflow))
    ) {
      try {
        trustedQuotedOrderId = await resolveQuotedCustomerFeedback(
          restaurantId,
          sender.normalizedPhone,
          input.quotedMessageId
        );
      } catch (error) {
        console.error("[customerAgent] quoted feedback lookup failed", {
          restaurantId,
          errorType: error instanceof Error ? error.name : "UnknownError"
        });
      }
    }

    if (
      input.quotedMessageId &&
      ambiguousShortReply &&
      competingOrderWorkflow
    ) {
      try {
        trustedCustomerReplyContext =
          (await resolveQuotedCustomerActiveOrder(
            restaurantId,
            sender.normalizedPhone,
            input.quotedMessageId,
            activeDraft
          )) ?? undefined;
      } catch (error) {
        console.error("[customerAgent] quoted active-order lookup failed", {
          restaurantId,
          errorType: error instanceof Error ? error.name : "UnknownError"
        });
      }
    }

    if (
      ambiguousShortReply &&
      (workflowStateLoadFailed ||
        (competingOrderWorkflow &&
          hasActiveFeedbackWorkflow &&
          !trustedQuotedOrderId &&
          !trustedCustomerReplyContext))
    ) {
      const clarificationMessage = workflowStateLoadFailed
        ? "I can’t safely tell which customer workflow that reply belongs to. Please say whether it is for your current order or an earlier order check-in."
        : buildCompetingCustomerWorkflowClarification(
            message,
            activeDraft,
            activeCheckIns
          );

      await saveAgentConversationMessage({
        restaurantId,
        senderPhone: sender.normalizedPhone,
        senderRole: sender.role,
        direction: "user",
        content: message,
        metadata: {
          source: "deterministic_customer_workflow_clarification",
          inboundEventId: input.inboundEventId
        }
      });
      await saveAgentConversationMessage({
        restaurantId,
        senderPhone: sender.normalizedPhone,
        senderRole: sender.role,
        direction: "assistant",
        content: clarificationMessage,
        metadata: {
          source: "deterministic_customer_workflow_clarification",
          activeDraftStep: activeDraft?.currentStep,
          activeFeedbackOrderCount: activeCheckIns.length
        }
      });

      return {
        success: true,
        message: clarificationMessage,
        data: {
          workflowClarificationRequired: true
        },
        source: "legacy_customer",
        sender
      };
    }

    const shouldHandleFeedback =
      explicitNaturalFeedback ||
      (ambiguousShortReply && Boolean(trustedQuotedOrderId)) ||
      (exactCheckInReply &&
        (!competingOrderWorkflow || Boolean(trustedQuotedOrderId)));
    const feedbackResult: HandleOrderFeedbackResponseResult =
      shouldHandleFeedback
        ? await handleCustomerFeedback({
            restaurantId,
            customerPhone: sender.normalizedPhone,
            customerName: sender.name,
            message,
            inboundEventId: input.inboundEventId,
            trustedOrderId: trustedQuotedOrderId ?? undefined
          })
        : { handled: false, success: false };

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

  let staffAgentFallbackResult: AgentOrchestratorResult | undefined;
  let staffAgentFallbackReason: string | undefined;
  let staffImageWorkflow: Awaited<
    ReturnType<typeof buildStaffOperationalState>
  >["imageWorkflow"] = null;
  let staffOperationalState: Awaited<
    ReturnType<typeof buildStaffOperationalState>
  > | undefined;
  let staffOrderMutationIntent: StaffOrderMutationIntent | null = null;
  let currentStaffConfirmation: CurrentStaffConfirmation = null;
  let latestPendingToolActionForDecision: Awaited<
    ReturnType<typeof findLatestPendingToolAction>
  > = null;

  if (shouldUseAiFirstStaffTextRouting(sender.role, aiProviderName)) {
    let agentResult: AgentOrchestratorResult | undefined;
    let staffState = createEmptyStaffOperationalState(sender.role);

    try {
      staffState = await buildStaffState({
        restaurant: input.restaurant,
        sender,
        quotedMessageId: input.quotedMessageId
      });
    } catch (error) {
      console.error("[staffState] build failed", {
        restaurantId,
        role: sender.role,
        errorType: error instanceof Error ? error.name : "UnknownError"
      });
    }

    staffImageWorkflow = staffState.imageWorkflow;
    staffOperationalState = staffState;
    const genericStaffConfirmationMessage =
      !hasExplicitImageWorkflowLanguage(message) &&
      (isPendingActionConfirmationMessage(message) ||
        isPendingActionCancellationMessage(message));

    if (genericStaffConfirmationMessage) {
      latestPendingToolActionForDecision = await findLatestPendingAction({
        restaurantId,
        restaurant: input.restaurant,
        sender,
        originalMessage: message,
        quotedMessageId: input.quotedMessageId
      });
      currentStaffConfirmation = resolveCurrentStaffConfirmation(
        staffImageWorkflow,
        latestPendingToolActionForDecision
      );
    }

    const pendingOrderSelection = staffState.recentReferences.orderSelection;
    const pendingSelectionReply = pendingOrderSelection
      ? parseOwnerSelectionReply(
          message,
          pendingOrderSelection.candidates.length
        )
      : null;

    if (
      pendingOrderSelection?.decision === "reject" &&
      pendingOrderSelection.awaitingReason &&
      pendingSelectionReply?.type === "cancel"
    ) {
      // Cancellation is resolved before the AI can execute tools. This prevents
      // an awaiting-reason turn such as "cancel" from ever being supplied to
      // reject_order as though it were the owner's rejection reason.
      const cancellationResult = await handleSavedSelection(
        restaurantId,
        sender.normalizedPhone,
        message,
        sender.role as Extract<SenderRole, "owner" | "manager">
      );
      const cancellationResponse: RestaurantAgentResponse = {
        success: cancellationResult.handled && cancellationResult.success,
        message: cancellationResult.handled
          ? cancellationResult.message
          : "That pending order selection is no longer active.",
        data: cancellationResult.data,
        source: "legacy_owner",
        sender
      };

      await saveAssistantResponse(
        restaurantId,
        sender,
        cancellationResponse,
        {
          source: "deterministic_owner_order_selection",
          reason: "explicit_selection_cancellation",
          success: cancellationResponse.success
        }
      );

      return cancellationResponse;
    }

    if (
      genericStaffConfirmationMessage &&
      currentStaffConfirmation &&
      !pendingOrderSelection
    ) {
      const pendingDecisionContext = {
        restaurantId,
        restaurant: input.restaurant,
        sender,
        originalMessage: message,
        quotedMessageId: input.quotedMessageId,
        trustedStaffOrderSelection: pendingOrderSelection
      };
      const isConfirmation = isPendingActionConfirmationMessage(message);

      if (currentStaffConfirmation.kind === "tool") {
        if (isConfirmation) {
          const pendingActions = await findPendingActions(
            pendingDecisionContext
          );

          if (pendingActions.length > 1) {
            const numberMatch = message.trim().match(/(\d+)$/);
            const selectedIndex = numberMatch
              ? parseInt(numberMatch[1], 10) - 1
              : -1;
            const selectedAction = pendingActions[selectedIndex];

            if (!selectedAction) {
              const clarificationMessage =
                buildAmbiguousPendingActionMessage(pendingActions);
              const clarificationResponse: RestaurantAgentResponse = {
                success: false,
                message: clarificationMessage,
                source: "legacy_owner",
                sender
              };

              await saveAssistantResponse(
                restaurantId,
                sender,
                clarificationResponse,
                {
                  source: "deterministic_pending_confirmation",
                  deterministicAction: "ambiguous_pending_action",
                  pendingActionCount: pendingActions.length
                }
              );

              return clarificationResponse;
            }

            const otherIds = pendingActions
              .filter((_, index) => index !== selectedIndex)
              .map((action) => action._id);

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

            currentStaffConfirmation = {
              kind: "tool",
              pendingActionId: String(selectedAction._id)
            };
          }

          const result = await executeConfirmedAction(
            currentStaffConfirmation.pendingActionId,
            pendingDecisionContext
          );
          const response: RestaurantAgentResponse = {
            success: result.success,
            message: result.message,
            data:
              result.data && typeof result.data === "object"
                ? { ...result.data }
                : undefined,
            source: "legacy_owner",
            sender
          };

          await saveAssistantResponse(restaurantId, sender, response, {
            source: "deterministic_pending_confirmation",
            deterministicAction: "confirm_pending_action",
            pendingActionId: currentStaffConfirmation.pendingActionId,
            success: result.success,
            code: result.code
          });

          return response;
        }

        const result = await cancelPendingActionById(
          currentStaffConfirmation.pendingActionId,
          pendingDecisionContext
        );
        const response: RestaurantAgentResponse = {
          success: result.success,
          message: result.message,
          data:
            result.data && typeof result.data === "object"
              ? { ...result.data }
              : undefined,
          source: "legacy_owner",
          sender
        };

        await saveAssistantResponse(restaurantId, sender, response, {
          source: "deterministic_pending_confirmation",
          deterministicAction: "cancel_pending_action",
          pendingActionId: currentStaffConfirmation.pendingActionId,
          success: result.success,
          code: result.code
        });

        return response;
      }

      const imageResult = await handlePendingImageReply({
        restaurantId,
        senderPhone: sender.normalizedPhone,
        senderRole: sender.role,
        message,
        pendingActionId: currentStaffConfirmation.pendingActionId
      });
      const response: RestaurantAgentResponse = {
        success: imageResult.handled && imageResult.success,
        message: imageResult.handled
          ? imageResult.message
          : "That pending image action is no longer active. Please try again.",
        source: "legacy_owner",
        sender
      };

      await saveAssistantResponse(restaurantId, sender, response, {
        source: "deterministic_pending_confirmation",
        deterministicAction: isConfirmation
          ? "confirm_pending_image_action"
          : "cancel_pending_image_action",
        pendingActionId: currentStaffConfirmation.pendingActionId,
        success: response.success
      });

      return response;
    }

    staffOrderMutationIntent = getStaffOrderMutationIntent(staffState, message);

    const staffStateForTurn =
      currentStaffConfirmation?.kind === "tool"
        ? {
            ...staffState,
            imageWorkflow: null
          }
        : staffState;

    try {
      agentResult = await runOrchestrator({
        restaurant: input.restaurant,
        sender,
        message,
        requestId: input.inboundEventId,
        quotedMessageId: input.quotedMessageId,
        staffState: staffStateForTurn
      });
    } catch {
      staffAgentFallbackReason = "orchestrator_exception";
    }

    if (agentResult) {
      let awaitingReasonConversationalResponse = false;
      let completedAwaitingRejectionOrderIds: string[] | undefined;

      if (staffOrderMutationIntent?.awaitingRejectionReason) {
        const expectedOrderIds =
          staffOrderMutationIntent.expectedOrderIds ?? [];
        const successfulOrderIds =
          getSuccessfulAwaitingRejectionOrderIds(
            staffOrderMutationIntent,
            agentResult
          );
        const allExpectedOrdersRejected =
          expectedOrderIds.length > 0 &&
          expectedOrderIds.every((orderId) =>
            successfulOrderIds.includes(orderId)
          );
        const attemptedRejection = agentResult.executedTools.some(
          (tool) => tool.name === "reject_order"
        );
        const claimedRejection = looksLikeRejectionCompletionClaim(
          agentResult.message || ""
        );
        let reconciliationResult:
          | Awaited<ReturnType<typeof reconcileAwaitingSelection>>
          | undefined;

        if (
          successfulOrderIds.length > 0 &&
          staffOrderMutationIntent.pendingSelectionActionId
        ) {
          try {
            reconciliationResult = await reconcileAwaitingSelection({
              restaurantId,
              senderPhone: sender.normalizedPhone,
              senderRole: sender.role,
              pendingActionId:
                staffOrderMutationIntent.pendingSelectionActionId,
              expectedOrderIds,
              successfulOrderIds
            });
          } catch (error) {
            console.error("[orderWorkflow] selection reconciliation failed", {
              restaurantId,
              senderRole: sender.role,
              errorType: error instanceof Error ? error.name : "UnknownError"
            });
          }
        }

        const selectionCompleted = Boolean(
          allExpectedOrdersRejected && reconciliationResult?.completed
        );
        const hasUsableMessage = Boolean(agentResult.message?.trim());

        if (!selectionCompleted) {
          const mustReturnSafeWorkflowResponse =
            successfulOrderIds.length > 0 ||
            attemptedRejection ||
            claimedRejection ||
            !agentResult.success ||
            !hasUsableMessage;

          if (mustReturnSafeWorkflowResponse) {
            const remainingOrderIds =
              reconciliationResult?.remainingOrderIds ??
              expectedOrderIds.filter(
                (orderId) => !successfulOrderIds.includes(orderId)
              );
            const safetyResponse: RestaurantAgentResponse = {
              success: false,
              message: buildAwaitingRejectionSafetyMessage(
                pendingOrderSelection?.candidates ?? [],
                successfulOrderIds,
                remainingOrderIds
              ),
              data:
                successfulOrderIds.length > 0
                  ? {
                      orders: successfulOrderIds.map((orderId) => ({
                        id: orderId
                      })),
                      orderEvent: "rejected",
                      notifyCustomer: true,
                      receiptRequired: false
                    }
                  : undefined,
              source: "legacy_owner",
              sender
            };

            await saveAssistantResponse(
              restaurantId,
              sender,
              safetyResponse,
              {
                source: "deterministic_owner_order_safety",
                reason: "awaiting_rejection_reason_not_fully_completed",
                pendingActionId:
                  staffOrderMutationIntent.pendingSelectionActionId,
                expectedOrderIds,
                successfulOrderIds,
                remainingOrderIds
              }
            );

            return safetyResponse;
          }

          awaitingReasonConversationalResponse = true;
        } else {
          completedAwaitingRejectionOrderIds = successfulOrderIds;
        }
      }

      const hasMeaningfulToolActivity = hasMeaningfulAgentToolActivity(
        agentResult.executedTools
      );
      const requiredImageWorkflowTool = getRequiredImageWorkflowTool(
        currentStaffConfirmation?.kind === "tool"
          ? null
          : staffState.imageWorkflow,
        message
      );
      const imageWorkflowNeedsFallback = Boolean(
        requiredImageWorkflowTool &&
          !hasMeaningfulNamedToolActivity(
            agentResult.executedTools,
            requiredImageWorkflowTool
          )
      );
      const orderWorkflowNeedsFallback = Boolean(
        staffOrderMutationIntent &&
          !awaitingReasonConversationalResponse &&
          !hasSuccessfulOrderMutationTool(staffOrderMutationIntent, agentResult)
      );
      const hasUsableMessage = Boolean(agentResult.message?.trim());
      const looksLikePendingDecision =
        !hasMeaningfulToolActivity &&
        agentResult.success &&
        hasUsableMessage &&
        (isPendingActionConfirmationMessage(message) ||
          isPendingActionCancellationMessage(message));
      const pendingAction = looksLikePendingDecision
        ? latestPendingToolActionForDecision ??
          (await findLatestPendingAction({
            restaurantId,
            restaurant: input.restaurant,
            sender,
            originalMessage: message,
            quotedMessageId: input.quotedMessageId
          }))
        : null;
      const pendingDecisionNeedsFallback = Boolean(
        pendingAction && currentStaffConfirmation?.kind !== "image"
      );
      const handledByAi =
        (!imageWorkflowNeedsFallback &&
          !orderWorkflowNeedsFallback &&
          hasMeaningfulToolActivity) ||
        (agentResult.success &&
          hasUsableMessage &&
          !imageWorkflowNeedsFallback &&
          !orderWorkflowNeedsFallback &&
          !pendingDecisionNeedsFallback);

      if (handledByAi) {
        const responseData = completedAwaitingRejectionOrderIds
          ? {
              ...(agentResult.data ?? {}),
              orders: completedAwaitingRejectionOrderIds.map((orderId) => ({
                id: orderId
              })),
              orderEvent: "rejected" as const,
              notifyCustomer: true,
              receiptRequired: false
            }
          : agentResult.data;

        await saveAgentConversationMessage({
          restaurantId,
          senderPhone: sender.normalizedPhone,
          senderRole: sender.role,
          direction: "assistant",
          content: agentResult.message || temporaryAgentErrorMessage,
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

        console.info("[restaurantAgent] staff text routing", {
          role: sender.role,
          path: "ai",
          success: agentResult.success,
          toolNames: agentResult.executedTools.map((tool) => tool.name)
        });

        return {
          success: agentResult.success,
          message: agentResult.message || temporaryAgentErrorMessage,
          data: responseData,
          source: "openrouter_agent",
          sender
        };
      }

      staffAgentFallbackResult = agentResult;
      staffAgentFallbackReason = imageWorkflowNeedsFallback
        ? "agent_did_not_complete_image_workflow"
        : orderWorkflowNeedsFallback
          ? "agent_did_not_complete_order_mutation"
        : pendingDecisionNeedsFallback
          ? "pending_action_requires_backend_confirmation"
          : agentResult.errorCode || "unusable_response";
    }

    console.warn(
      "[restaurantAgent] staff AI routing failed; using legacy fallback",
      {
        role: sender.role,
        reason: staffAgentFallbackReason || "unknown_failure"
      }
    );
  }

  const parsedSpecificItemName = parseSpecificMenuItemViewRequest(message);
  const specificItemName =
    (sender.role === "customer" && !customerOpenRouterEnabled) ||
    (sender.role !== "customer" && hasExplicitImageViewCue(message))
      ? parsedSpecificItemName
      : null;

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

  if (
    isMenuRequest(message) &&
    ((sender.role === "customer" && !customerOpenRouterEnabled) || aiProviderName !== "openrouter")
  ) {
    return handleLocalMenuRequest(input, sender);
  }

  if (sender.role === "customer") {
    if (customerOpenRouterEnabled) {
      console.info("[customerAgent] ai-first turn started", {
        restaurantId,
        senderRole: sender.role
      });
      // ── Stale-clarification guard ──────────────────────────────────────────
      // Only explicit fresh-start commands clear a pending clarification. Generic
      // food/menu language stays available to the AI as trusted turn context.
      if (isExplicitCustomerClarificationResetMessage(message)) {
        await cancelCustomerClarifications({
          restaurantId,
          senderPhone: sender.normalizedPhone
        });
      }

      const agentResult = await runOrchestrator({
        restaurant: input.restaurant,
        sender,
        message,
        requestId: input.inboundEventId,
        quotedMessageId: input.quotedMessageId,
        trustedCustomerReplyContext
      });

      console.info("[customerAgent] AI tools executed", {
        restaurantId,
        tools: agentResult.executedTools.map((tool) => tool.name)
      });

      if (agentResult.data?.menuItemImage) {
        const menuItemImage = agentResult.data.menuItemImage as Record<string, unknown>;
        console.info("[customerAgent] trusted menu image prepared", {
          restaurantId,
          menuItemId:
            typeof menuItemImage.menuItemId === "string"
              ? menuItemImage.menuItemId
              : undefined,
          hasImage: true
        });
      }

      const successfulCustomerMutation = agentResult.executedTools.some(
        (tool) => tool.success && customerMutationToolNames.has(tool.name)
      );

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

      if (
        !agentResult.success &&
        openRouterConfig.customerLegacyFallback &&
        !successfulCustomerMutation
      ) {
        console.warn("[customerAgent] AI failed; explicit legacy fallback allowed", {
          restaurantId,
          senderRole: sender.role
        });

        return handleLocalCustomerRequest(input, sender, legacyCustomerHandler);
      }

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

      if (!agentResult.success && successfulCustomerMutation) {
        console.warn("[customerAgent] legacy fallback suppressed after mutation", {
          restaurantId,
          tools: agentResult.executedTools
            .filter((tool) => tool.success)
            .map((tool) => tool.name)
        });
      }

      return {
        success: agentResult.success,
        message: agentResult.message || temporaryAgentErrorMessage,
        data: agentResult.data,
        source: "openrouter_agent",
        sender
      };
    }

    return handleLocalCustomerRequest(input, sender, legacyCustomerHandler);
  }

  const executionContext = {
    restaurantId,
    restaurant: input.restaurant,
    sender,
    originalMessage: message,
    quotedMessageId: input.quotedMessageId,
    trustedStaffOrderSelection:
      staffOperationalState?.recentReferences.orderSelection
  };
  const legacyStaffSource =
    aiProviderName === "openrouter" ? "legacy_owner" : "hermes_tools";

  if (sender.role === "owner" || sender.role === "manager") {
    const genericDecisionTargetsTool =
      currentStaffConfirmation?.kind === "tool" &&
      !hasExplicitImageWorkflowLanguage(message) &&
      (isPendingActionConfirmationMessage(message) ||
        isPendingActionCancellationMessage(message));
    const pendingImageResult = genericDecisionTargetsTool
      ? { handled: false, success: false, message: "" }
      : await handlePendingImageReply({
          restaurantId,
          senderPhone: sender.normalizedPhone,
          senderRole: sender.role,
          message,
          pendingActionId: staffImageWorkflow?.pendingActionId
        });

    if (pendingImageResult.handled) {
      console.warn("[imageWorkflow] legacy fallback", {
        restaurantId,
        senderRole: sender.role,
        reason:
          staffAgentFallbackReason ??
          (aiProviderName === "openrouter"
            ? "agent_did_not_complete_image_workflow"
            : "legacy_provider")
      });
      await saveAssistantResponse(
        restaurantId,
        sender,
        {
          success: pendingImageResult.success,
          message: pendingImageResult.message,
          source: legacyStaffSource,
          sender
        },
        {
          source: "deterministic_menu_item_image_reply",
          success: pendingImageResult.success,
          itemName: pendingImageResult.itemName,
          pendingActionId: pendingImageResult.pendingActionId
        }
      );

      return {
        success: pendingImageResult.success,
        message: pendingImageResult.message,
        source: legacyStaffSource,
        sender
      };
    }

    const imageRequestResult = await rememberImageRequest({
      restaurantId,
      senderPhone: sender.normalizedPhone,
      senderRole: sender.role,
      message
    });

    if (imageRequestResult.handled) {
      console.warn("[imageWorkflow] legacy fallback", {
        restaurantId,
        senderRole: sender.role,
        reason: staffAgentFallbackReason ?? "agent_unavailable"
      });
      await saveAssistantResponse(
        restaurantId,
        sender,
        {
          success: imageRequestResult.success,
          message: imageRequestResult.message,
          source: legacyStaffSource,
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
        source: legacyStaffSource,
        sender
      };
    }
  }

  const ownerOrderDecision =
    sender.role === "owner" || sender.role === "manager"
      ? parseOrderDecision(message)
      : null;
  const simpleOwnerDecision =
    sender.role === "owner" || sender.role === "manager"
      ? parseSimpleDecision(message)
      : null;

  if (sender.role === "owner" || sender.role === "manager") {
    const selectionResult = await handleSavedSelection(
      restaurantId,
      sender.normalizedPhone,
      message,
      sender.role
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
        source: legacyStaffSource,
        sender
      };
    }
  }

  if (
    aiProviderName === "openrouter" &&
    (sender.role === "owner" || sender.role === "manager") &&
    staffOrderMutationIntent
  ) {
    let fallbackResponse: RestaurantAgentResponse;
    let fallbackMetadata: Record<string, unknown>;

    if (
      staffOrderMutationIntent.kind === "reject" &&
      staffOrderMutationIntent.missingReason &&
      staffOrderMutationIntent.orderReference
    ) {
      const result = await requestRejectionReason({
        restaurantId,
        senderPhone: sender.normalizedPhone,
        senderRole: sender.role,
        orderReference: staffOrderMutationIntent.orderReference
      });
      fallbackResponse = {
        success: result.success,
        message: result.message,
        data: result.data,
        source: legacyStaffSource,
        sender
      };
      fallbackMetadata = {
        source: "deterministic_owner_order_safety",
        reason: "rejection_reason_required",
        pendingActionId: result.data?.pendingActionId
      };
    } else if (!staffOrderMutationIntent.orderReference) {
      if (
        staffOrderMutationIntent.kind === "complete" ||
        staffOrderMutationIntent.kind === "progress"
      ) {
        const activeOrders = staffOperationalState?.orders.recentActive ?? [];
        const clarificationMessage = activeOrders.length
          ? `Which order should I mark as ${
              staffOrderMutationIntent.targetStatus?.replace(/_/g, " ") ?? "updated"
            }?`
          : "There are no active orders to update.";
        fallbackResponse = {
          success: activeOrders.length > 0,
          message: clarificationMessage,
          source: legacyStaffSource,
          sender
        };
        fallbackMetadata = {
          source: "deterministic_owner_order_safety",
          reason: activeOrders.length ? "ambiguous_active_orders" : "no_active_orders"
        };
      } else {
        const quotedResult = await resolveQuotedDecision(
          restaurantId,
          input.quotedMessageId,
          staffOrderMutationIntent.kind,
          staffOrderMutationIntent.reason,
          sender.normalizedPhone,
          sender.role
        );
        const result = quotedResult.handled
          ? quotedResult
          : await handleUnquotedDecision(
              restaurantId,
              sender.normalizedPhone,
              staffOrderMutationIntent.kind,
              sender.role,
              staffOrderMutationIntent.reason
            );
        fallbackResponse = {
          success: result.success,
          message: result.message,
          data: result.data,
          source: legacyStaffSource,
          sender
        };
        fallbackMetadata = {
          source: "deterministic_owner_order_safety",
          reason: quotedResult.handled
            ? "trusted_quoted_order"
            : staffOrderMutationIntent.ambiguous
              ? "ambiguous_pending_orders"
              : "trusted_unique_pending_order"
        };
      }
    } else {
      const toolName = staffOrderMutationIntent.requiredTool;
      const result = await executeTool(
        toolName,
        {
          orderId: staffOrderMutationIntent.orderReference,
          ...(staffOrderMutationIntent.reason
            ? { reason: staffOrderMutationIntent.reason }
            : {}),
          ...(staffOrderMutationIntent.requiredTool === "update_order_status"
            ? { status: staffOrderMutationIntent.targetStatus }
            : {})
        },
        executionContext
      );
      fallbackResponse = {
        success: result.success,
        message: result.message,
        data:
          result.data && typeof result.data === "object"
            ? { ...result.data }
            : undefined,
        source: legacyStaffSource,
        sender
      };
      fallbackMetadata = {
        source: "deterministic_owner_order_safety",
        reason: staffAgentFallbackReason,
        toolName,
        success: result.success,
        code: result.code
      };
    }

    console.warn("[orderWorkflow] deterministic safety fallback", {
      restaurantId,
      senderRole: sender.role,
      kind: staffOrderMutationIntent.kind,
      reason: staffAgentFallbackReason
    });
    await saveAssistantResponse(
      restaurantId,
      sender,
      fallbackResponse,
      fallbackMetadata
    );
    return fallbackResponse;
  }

  if (simpleOwnerDecision) {
    const quotedResult = await resolveQuotedDecision(
      restaurantId,
      input.quotedMessageId,
      simpleOwnerDecision,
      undefined,
      sender.normalizedPhone,
      sender.role
    );
    const result = quotedResult.handled
      ? quotedResult
      : await handleUnquotedDecision(
          restaurantId,
          sender.normalizedPhone,
          simpleOwnerDecision,
          sender.role
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
      source: legacyStaffSource,
      sender
    };
  }

  if (ownerOrderDecision) {
    if (
      ownerOrderDecision.decision === "reject" &&
      !cleanInlineRejectionReason(ownerOrderDecision.reason)
    ) {
      const result = await requestRejectionReason({
        restaurantId,
        senderPhone: sender.normalizedPhone,
        senderRole: sender.role,
        orderReference: ownerOrderDecision.orderReference
      });

      await saveAgentConversationMessage({
        restaurantId,
        senderPhone: sender.normalizedPhone,
        senderRole: sender.role,
        direction: "assistant",
        content: result.message,
        metadata: {
          source: "deterministic_owner_order_decision",
          reason: "rejection_reason_required",
          success: result.success
        }
      });

      return {
        success: result.success,
        message: result.message,
        data: result.data,
        source: legacyStaffSource,
        sender
      };
    }

    const result = await executeTool(
      ownerOrderDecision.decision === "accept" ? "confirm_order" : "reject_order",
      {
        orderReference: ownerOrderDecision.orderReference,
        ...(ownerOrderDecision.reason
          ? { reason: cleanInlineRejectionReason(ownerOrderDecision.reason) }
          : {})
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
      source: legacyStaffSource,
      sender
    };
  }

  const pendingAction =
    aiProviderName === "openrouter"
      ? latestPendingToolActionForDecision ??
        (await findLatestPendingAction(executionContext))
      : null;

  if (
    aiProviderName === "openrouter" &&
    pendingAction &&
    currentStaffConfirmation?.kind !== "image" &&
    isPendingActionConfirmationMessage(message)
  ) {
    const pendingActions = await findPendingActions(executionContext);

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

          const result = await executeConfirmedAction(
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
              source: "legacy_owner",
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
            source: legacyStaffSource,
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
          source: "legacy_owner",
          deterministicAction: "ambiguous_pending_action",
          pendingActionCount: pendingActions.length
        }
      });

      return {
        success: false,
        message: clarificationMessage,
        source: legacyStaffSource,
        sender
      };
    }

    const result = await executeConfirmedAction(
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
        source: "legacy_owner",
        deterministicAction: "confirm_pending_action",
        success: result.success,
        code: result.code
      }
    });

    return {
      success: result.success,
      message: result.message,
      data: result.data && typeof result.data === "object" ? { ...result.data } : undefined,
      source: legacyStaffSource,
      sender
    };
  }

  if (
    aiProviderName === "openrouter" &&
    pendingAction &&
    currentStaffConfirmation?.kind !== "image" &&
    isPendingActionCancellationMessage(message)
  ) {
    const result = await cancelPendingAction(executionContext);

    await saveAgentConversationMessage({
      restaurantId,
      senderPhone: sender.normalizedPhone,
      senderRole: sender.role,
      direction: "assistant",
      content: result.message,
      metadata: {
        source: "legacy_owner",
        deterministicAction: "cancel_pending_action",
        success: result.success,
        code: result.code
      }
    });

    return {
      success: result.success,
      message: result.message,
      data: result.data && typeof result.data === "object" ? { ...result.data } : undefined,
      source: legacyStaffSource,
      sender
    };
  }

  if (aiProviderName === "openrouter") {
    const safeMessage =
      staffAgentFallbackReason === "pending_action_requires_backend_confirmation"
        ? "I couldn't confirm that pending action safely. Please try again."
        : staffAgentFallbackResult?.message || temporaryAgentErrorMessage;
    await saveAgentConversationMessage({
      restaurantId,
      senderPhone: sender.normalizedPhone,
      senderRole: sender.role,
      direction: "assistant",
      content: safeMessage,
      metadata: {
        source: "openrouter_agent",
        routingPath: "legacy_fallback_unhandled",
        fallbackReason: staffAgentFallbackReason,
        provider: staffAgentFallbackResult?.provider,
        model: staffAgentFallbackResult?.model,
        responseId: staffAgentFallbackResult?.responseId,
        success: false,
        executedTools: staffAgentFallbackResult?.executedTools,
        usage: staffAgentFallbackResult?.usage
      }
    });

    return {
      success: false,
      message: safeMessage,
      data: staffAgentFallbackResult?.data,
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
