import { createHash, randomUUID } from "crypto";
import type { UpdateQuery } from "mongoose";
import type { CommerceToolExecutionContext } from "../types/agent.types";
import {
  CommerceShoppingDraft,
  type CommerceCheckoutState,
  type CommerceDraftCustomer,
  type CommerceDraftItem,
  type ICommerceShoppingDraftDocument
} from "../models/commerceShoppingDraft.model";
import {
  CommerceIntegrationError,
  createCommerceCheckoutQuote,
  createCommerceCheckoutSession,
  getCommerceCheckoutStatus,
  getCommerceProduct
} from "./commerceIntegration.service";

const unresolvedCheckoutStates = new Set([
  "initializing",
  "uncertain",
  "pending",
  "needs_attention"
]);

const normalizeCustomerKey = (context: CommerceToolExecutionContext): string => {
  const customerKey = context.sender.customerKey?.trim().toLowerCase();
  if (!customerKey || customerKey.length < 4 || customerKey.length > 200) {
    throw new CommerceIntegrationError(
      "COMMERCE_CUSTOMER_IDENTITY_REQUIRED",
      "I could not verify your WhatsApp shopping identity. Please try again."
    );
  }
  return customerKey;
};

const trustedNotificationPhone = (
  context: CommerceToolExecutionContext
): string | undefined => {
  const phone = context.sender.normalizedPhone?.trim();
  return /^\+[1-9]\d{7,14}$/.test(phone ?? "") ? phone : undefined;
};

const scopedDraft = (
  context: CommerceToolExecutionContext
) => ({
  businessId: context.businessId,
  customerKey: normalizeCustomerKey(context)
});

const loadDraft = async (
  context: CommerceToolExecutionContext
): Promise<ICommerceShoppingDraftDocument> => {
  const scope = scopedDraft(context);
  let draft = await CommerceShoppingDraft.findOne(scope).select(
    "+appliedActionKeys +checkout.idempotencyKey"
  );
  if (draft) {
    const notificationPhone = trustedNotificationPhone(context);
    if (notificationPhone && draft.notificationPhone !== notificationPhone) {
      const hasUnresolvedCheckout = Boolean(
        draft.checkout && unresolvedCheckoutStates.has(draft.checkout.lifecycle)
      );
      const updated = await CommerceShoppingDraft.findOneAndUpdate(
        { ...scope, version: draft.version },
        {
          $set: { notificationPhone },
          ...(hasUnresolvedCheckout ? {} : {
            $inc: { version: 1 },
            $unset: { quote: "", checkout: "" }
          })
        },
        { new: true }
      ).select("+appliedActionKeys +checkout.idempotencyKey");
      if (updated) return updated;
      return loadDraft(context);
    }
    return draft;
  }
  try {
    draft = await CommerceShoppingDraft.create({
      ...scope,
      notificationPhone: trustedNotificationPhone(context),
      items: [],
      customer: {},
      orderNotes: ""
    });
  } catch (error) {
    const duplicate = error as { code?: number };
    if (duplicate.code !== 11000) throw error;
    draft = await CommerceShoppingDraft.findOne(scope).select(
      "+appliedActionKeys +checkout.idempotencyKey"
    );
  }
  if (!draft) throw new Error("Commerce draft could not be loaded");
  return draft;
};

const actionKey = (
  context: CommerceToolExecutionContext,
  action: string,
  input: unknown
): string => {
  const requestId = context.requestId?.trim();
  if (!requestId) {
    throw new CommerceIntegrationError(
      "COMMERCE_REQUEST_ID_REQUIRED",
      "I could not safely apply that cart change. Please send it again."
    );
  }
  return createHash("sha256")
    .update(`${requestId}:${action}:${JSON.stringify(input)}`, "utf8")
    .digest("hex");
};

const publicCheckout = (checkout: CommerceCheckoutState | undefined) => checkout
  ? {
      lifecycle: checkout.lifecycle,
      orderNumber: checkout.orderNumber,
      amountPesewas: checkout.amountPesewas,
      currency: checkout.currency,
      paymentStatus: checkout.paymentStatus,
      fulfillmentStatus: checkout.fulfillmentStatus,
      deliveryFeeStatus: checkout.deliveryFeeStatus,
      deliveryFee: "arranged_separately" as const,
      paymentUrl: checkout.paymentUrl,
      receipt: checkout.receipt,
      lastCheckedAt: checkout.lastCheckedAt,
      lastErrorCode: checkout.lastErrorCode
    }
  : undefined;

export const summarizeCommerceDraft = (
  draft: ICommerceShoppingDraftDocument,
  idempotent = false
) => ({
  version: draft.version,
  items: draft.items.map((item) => ({
    productId: item.productId,
    name: item.name,
    quantity: item.quantity
  })),
  customer: {
    fullName: draft.customer.fullName,
    email: draft.customer.email,
    deliveryAddress: draft.customer.deliveryAddress,
    whatsappConsent: draft.customer.whatsappConsent
  },
  orderNotes: draft.orderNotes,
  missing: [
    draft.items.length ? undefined : "items",
    draft.customer.fullName ? undefined : "fullName",
    draft.customer.email ? undefined : "email",
    draft.customer.deliveryAddress ? undefined : "deliveryAddress",
    draft.customer.whatsappConsent === true ? undefined : "whatsappConsent",
    draft.notificationPhone ? undefined : "verifiedWhatsappNumber"
  ].filter((value): value is string => Boolean(value)),
  quote: draft.quote
    ? {
        draftVersion: draft.quote.draftVersion,
        items: draft.quote.items,
        subtotalPesewas: draft.quote.subtotalPesewas,
        totalPesewas: draft.quote.totalPesewas,
        currency: draft.quote.currency,
        deliveryFee: draft.quote.deliveryFee,
        expiresAt: draft.quote.expiresAt,
        presented: Boolean(draft.quote.presentation?.outboundMessageId),
        confirmed: Boolean(draft.quote.confirmation),
        current: draft.quote.draftVersion === draft.version
      }
    : undefined,
  checkout: publicCheckout(draft.checkout),
  idempotent
});

export const getCommerceDraft = async (context: CommerceToolExecutionContext) =>
  summarizeCommerceDraft(await loadDraft(context));

export const buildCommerceReplyQueueMetadata = async (
  context: CommerceToolExecutionContext,
  assistantTurnId: string,
  draftVersion: number,
  options: { quotePresented: boolean; consentQuestionAsked: boolean }
): Promise<Record<string, unknown> | undefined> => {
  const customerRequestId = context.requestId?.trim();
  const normalizedTurnId = assistantTurnId.trim();
  if (!customerRequestId || !normalizedTurnId) return undefined;
  const draft = await CommerceShoppingDraft.findOne({
    ...scopedDraft(context),
    version: draftVersion
  });
  if (!draft) return undefined;
  const scope = {
    businessId: context.businessId,
    customerKey: normalizeCustomerKey(context),
    draftVersion,
    assistantTurnId: normalizedTurnId,
    customerRequestId
  };
  const metadata: Record<string, unknown> = {};
  if (
    options.quotePresented &&
    draft.quote?.draftVersion === draftVersion &&
    draft.quote.expiresAt.getTime() > Date.now() &&
    !draft.checkout
  ) {
    metadata.commerceQuotePresentation = {
      ...scope,
      quoteId: draft.quote.quoteId
    };
  }
  if (
    options.consentQuestionAsked &&
    draft.customer.whatsappConsent !== true
  ) {
    metadata.commerceConsentQuestion = scope;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
};

const readQueueString = (
  value: Record<string, unknown>,
  key: string
): string | undefined =>
  typeof value[key] === "string" && value[key].trim()
    ? value[key].trim()
    : undefined;

export const recordSentCommerceReplyState = async (input: {
  metadata?: Record<string, unknown>;
  outboundMessageId: string;
  providerMessageId?: string;
  sentAt: Date;
}): Promise<void> => {
  const quote = input.metadata?.commerceQuotePresentation;
  if (quote && typeof quote === "object") {
    const value = quote as Record<string, unknown>;
    const businessId = readQueueString(value, "businessId");
    const customerKey = readQueueString(value, "customerKey");
    const quoteId = readQueueString(value, "quoteId");
    const assistantTurnId = readQueueString(value, "assistantTurnId");
    const customerRequestId = readQueueString(value, "customerRequestId");
    const draftVersion = typeof value.draftVersion === "number" &&
      Number.isSafeInteger(value.draftVersion)
      ? value.draftVersion
      : undefined;
    if (
      businessId && customerKey && quoteId && assistantTurnId &&
      customerRequestId && draftVersion !== undefined
    ) {
      await CommerceShoppingDraft.updateOne(
        {
          businessId,
          customerKey,
          version: draftVersion,
          "quote.quoteId": quoteId,
          "quote.draftVersion": draftVersion,
          "quote.expiresAt": { $gt: input.sentAt },
          checkout: { $exists: false }
        },
        {
          $set: {
            "quote.presentation": {
              assistantTurnId,
              customerRequestId,
              outboundMessageId: input.outboundMessageId,
              ...(input.providerMessageId
                ? { providerMessageId: input.providerMessageId }
                : {}),
              presentedAt: input.sentAt
            }
          },
          $unset: { "quote.confirmation": "" }
        }
      );
    }
  }

  const consent = input.metadata?.commerceConsentQuestion;
  if (consent && typeof consent === "object") {
    const value = consent as Record<string, unknown>;
    const businessId = readQueueString(value, "businessId");
    const customerKey = readQueueString(value, "customerKey");
    const assistantTurnId = readQueueString(value, "assistantTurnId");
    const customerRequestId = readQueueString(value, "customerRequestId");
    const draftVersion = typeof value.draftVersion === "number" &&
      Number.isSafeInteger(value.draftVersion)
      ? value.draftVersion
      : undefined;
    if (
      businessId && customerKey && assistantTurnId && customerRequestId &&
      draftVersion !== undefined
    ) {
      await CommerceShoppingDraft.updateOne(
        {
          businessId,
          customerKey,
          version: draftVersion,
          "customer.whatsappConsent": { $ne: true }
        },
        {
          $set: {
            pendingConsentQuestion: {
              assistantTurnId,
              customerRequestId,
              outboundMessageId: input.outboundMessageId,
              askedAt: input.sentAt
            }
          }
        }
      );
    }
  }
};

const mutateDraft = async (
  context: CommerceToolExecutionContext,
  action: string,
  input: unknown,
  mutate: (draft: ICommerceShoppingDraftDocument) => {
    items?: CommerceDraftItem[];
    customer?: CommerceDraftCustomer;
    orderNotes?: string;
    clearPendingConsentQuestion?: boolean;
    expectedPendingConsentQuestion?: {
      assistantTurnId: string;
      customerRequestId: string;
      outboundMessageId: string;
    };
  }
) => {
  const key = actionKey(context, action, input);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const draft = await loadDraft(context);
    if (draft.appliedActionKeys.includes(key)) {
      return summarizeCommerceDraft(draft, true);
    }
    const changes = mutate(draft);
    const update: UpdateQuery<ICommerceShoppingDraftDocument> = {
      $set: {
        ...(changes.items ? { items: changes.items } : {}),
        ...(changes.customer ? { customer: changes.customer } : {}),
        ...(changes.orderNotes !== undefined ? { orderNotes: changes.orderNotes } : {}),
        ...(trustedNotificationPhone(context)
          ? { notificationPhone: trustedNotificationPhone(context) }
          : {})
      },
      $inc: { version: 1 },
      $push: { appliedActionKeys: { $each: [key], $slice: -100 } }
    };
    const unsetFields: Record<string, ""> = {};
    if (changes.clearPendingConsentQuestion) {
      unsetFields.pendingConsentQuestion = "";
    }
    if (!draft.checkout || !unresolvedCheckoutStates.has(draft.checkout.lifecycle)) {
      unsetFields.quote = "";
      unsetFields.checkout = "";
    }
    if (Object.keys(unsetFields).length > 0) {
      update.$unset = unsetFields;
    }
    const updated = await CommerceShoppingDraft.findOneAndUpdate(
      {
        ...scopedDraft(context),
        version: draft.version,
        appliedActionKeys: { $ne: key },
        ...(changes.expectedPendingConsentQuestion
          ? {
              "pendingConsentQuestion.assistantTurnId":
                changes.expectedPendingConsentQuestion.assistantTurnId,
              "pendingConsentQuestion.customerRequestId":
                changes.expectedPendingConsentQuestion.customerRequestId,
              "pendingConsentQuestion.outboundMessageId":
                changes.expectedPendingConsentQuestion.outboundMessageId
            }
          : {})
      },
      update,
      { new: true }
    ).select("+appliedActionKeys +checkout.idempotencyKey");
    if (updated) return summarizeCommerceDraft(updated);
    if (changes.expectedPendingConsentQuestion) {
      throw new CommerceIntegrationError(
        "COMMERCE_WHATSAPP_CONSENT_QUESTION_CHANGED",
        "The WhatsApp notification question changed. Please answer the latest question."
      );
    }
  }
  throw new CommerceIntegrationError(
    "COMMERCE_DRAFT_CONFLICT",
    "Your cart changed at the same time. Please try that change again."
  );
};

export const addCommerceDraftItem = async (
  context: CommerceToolExecutionContext,
  productId: string,
  quantity: number
) => {
  const verified = await getCommerceProduct(context.business, productId);
  if (!verified.product.available) {
    throw new CommerceIntegrationError(
      "PRODUCT_UNAVAILABLE",
      `${verified.product.name} is currently unavailable.`
    );
  }
  if (
    verified.product.stockQuantity !== undefined &&
    quantity > verified.product.stockQuantity
  ) {
    throw new CommerceIntegrationError(
      "INSUFFICIENT_STOCK",
      `Only ${verified.product.stockQuantity} of ${verified.product.name} are currently available.`
    );
  }
  return mutateDraft(context, "add_item", { productId, quantity }, (draft) => {
    const items = draft.items.map((item) => ({
      productId: item.productId,
      name: item.name,
      quantity: item.quantity,
      verifiedAt: item.verifiedAt
    }));
    const existing = items.find((item) => item.productId === productId);
    const nextQuantity = (existing?.quantity ?? 0) + quantity;
    if (nextQuantity > 20) {
      throw new CommerceIntegrationError(
        "COMMERCE_QUANTITY_INVALID",
        "A product quantity cannot exceed 20."
      );
    }
    if (
      verified.product.stockQuantity !== undefined &&
      nextQuantity > verified.product.stockQuantity
    ) {
      throw new CommerceIntegrationError(
        "INSUFFICIENT_STOCK",
        `Only ${verified.product.stockQuantity} of ${verified.product.name} are currently available.`
      );
    }
    if (existing) {
      existing.quantity = nextQuantity;
      existing.name = verified.product.name;
      existing.verifiedAt = new Date();
    } else {
      if (items.length >= 20) {
        throw new CommerceIntegrationError(
          "COMMERCE_CART_LIMIT_REACHED",
          "The cart can contain at most 20 different products."
        );
      }
      items.push({
        productId,
        name: verified.product.name,
        quantity,
        verifiedAt: new Date()
      });
    }
    return { items };
  });
};

export const removeCommerceDraftItem = async (
  context: CommerceToolExecutionContext,
  productId: string
) => mutateDraft(context, "remove_item", { productId }, (draft) => {
  if (!draft.items.some((item) => item.productId === productId)) {
    throw new CommerceIntegrationError(
      "COMMERCE_DRAFT_ITEM_NOT_FOUND",
      "That verified product is not in your cart."
    );
  }
  return {
    items: draft.items
      .filter((item) => item.productId !== productId)
      .map((item) => ({
        productId: item.productId,
        name: item.name,
        quantity: item.quantity,
        verifiedAt: item.verifiedAt
      }))
  };
});

export const setCommerceDraftItemQuantity = async (
  context: CommerceToolExecutionContext,
  productId: string,
  quantity: number
) => {
  const verified = await getCommerceProduct(context.business, productId);
  if (!verified.product.available) {
    throw new CommerceIntegrationError(
      "PRODUCT_UNAVAILABLE",
      `${verified.product.name} is currently unavailable.`
    );
  }
  if (
    verified.product.stockQuantity !== undefined &&
    quantity > verified.product.stockQuantity
  ) {
    throw new CommerceIntegrationError(
      "INSUFFICIENT_STOCK",
      `Only ${verified.product.stockQuantity} of ${verified.product.name} are currently available.`
    );
  }
  return mutateDraft(context, "set_quantity", { productId, quantity }, (draft) => {
    if (!draft.items.some((item) => item.productId === productId)) {
      throw new CommerceIntegrationError(
        "COMMERCE_DRAFT_ITEM_NOT_FOUND",
        "That product is not in your cart."
      );
    }
    return {
      items: draft.items.map((item) => ({
        productId: item.productId,
        name: item.productId === productId ? verified.product.name : item.name,
        quantity: item.productId === productId ? quantity : item.quantity,
        verifiedAt: item.productId === productId ? new Date() : item.verifiedAt
      }))
    };
  });
};

const classifyContextualConsent = (
  message: string | undefined
): true | false | "ambiguous" => {
  const normalized = message?.trim().toLowerCase().replace(/[’]/g, "'") ?? "";
  const hasConditional = /\b(?:if|unless|provided|as long as|but only)\b/.test(normalized);
  const affirmative = /^(?:yes(?: please)?(?:,?\s+(?:send|notify)(?:\s+me|\s+them)?)?|yep|yeah|sure|okay|ok|i agree|i consent|i accept)[.!]*$/.test(normalized) ||
    /\b(?:i agree|i consent|i accept)\s+(?:to\s+)?(?:receive\s+)?whats?app\s+notifications?\b/.test(normalized);
  const negative = /^(?:no(?: thanks)?|nope|decline|no,?\s+(?:please\s+)?(?:do not|don't|dont)\s+(?:send|notify).*)[.!]*$/.test(normalized) ||
    /\b(?:no|do not|don't|dont|not|never|decline|refuse)\b.{0,32}\bwhats?app\b/.test(normalized) ||
    /\bwhats?app\b.{0,32}\b(?:no|do not|don't|dont|not|never|decline|refuse)\b/.test(normalized);
  if (hasConditional || affirmative === negative) return "ambiguous";
  return affirmative ? true : false;
};

export const updateCommerceDraftCustomer = async (
  context: CommerceToolExecutionContext,
  input: Partial<CommerceDraftCustomer> & { orderNotes?: string }
) => mutateDraft(context, "update_customer", input, (draft) => {
  let consentQuestion:
    | { assistantTurnId: string; customerRequestId: string; outboundMessageId: string }
    | undefined;
  if (input.whatsappConsent !== undefined) {
    const requestId = context.requestId?.trim();
    const question = draft.pendingConsentQuestion;
    const resolved = classifyContextualConsent(context.originalMessage);
    if (
      !question ||
      !question.outboundMessageId ||
      !requestId ||
      question.customerRequestId === requestId
    ) {
      throw new CommerceIntegrationError(
        "COMMERCE_WHATSAPP_CONSENT_QUESTION_REQUIRED",
        "Please answer the current WhatsApp notification question in a later message."
      );
    }
    if (resolved === "ambiguous" || resolved !== input.whatsappConsent) {
      throw new CommerceIntegrationError(
        "COMMERCE_WHATSAPP_CONSENT_AMBIGUOUS",
        "Please answer the WhatsApp notification question with a clear yes or no."
      );
    }
    consentQuestion = {
      assistantTurnId: question.assistantTurnId,
      customerRequestId: question.customerRequestId,
      outboundMessageId: question.outboundMessageId
    };
  }
  return {
    customer: {
      fullName: input.fullName ?? draft.customer.fullName,
      email: input.email ?? draft.customer.email,
      deliveryAddress: input.deliveryAddress ?? draft.customer.deliveryAddress,
      whatsappConsent: input.whatsappConsent ?? draft.customer.whatsappConsent
    },
    orderNotes: input.orderNotes ?? draft.orderNotes,
    clearPendingConsentQuestion: input.whatsappConsent !== undefined,
    expectedPendingConsentQuestion: consentQuestion
  };
});

export const clearCommerceDraft = async (context: CommerceToolExecutionContext) =>
  mutateDraft(context, "clear", {}, () => ({
    items: [],
    customer: {},
    orderNotes: "",
    clearPendingConsentQuestion: true
  }));

const requireCompleteDraft = (draft: ICommerceShoppingDraftDocument) => {
  const summary = summarizeCommerceDraft(draft);
  if (summary.missing.length > 0) {
    throw new CommerceIntegrationError(
      "COMMERCE_DRAFT_INCOMPLETE",
      `Please provide: ${summary.missing.join(", ")}.`
    );
  }
};

export const requestCommerceDraftQuote = async (
  context: CommerceToolExecutionContext
) => {
  const draft = await loadDraft(context);
  const key = actionKey(context, "request_quote", {});
  if (
    !draft.checkout &&
    draft.quote?.draftVersion === draft.version &&
    draft.quote.expiresAt.getTime() > Date.now()
  ) {
    return summarizeCommerceDraft(draft, true);
  }
  if (
    draft.appliedActionKeys.includes(key) &&
    draft.quote?.draftVersion === draft.version &&
    draft.quote.expiresAt.getTime() > Date.now()
  ) {
    return summarizeCommerceDraft(draft, true);
  }
  if (draft.appliedActionKeys.includes(key)) {
    throw new CommerceIntegrationError(
      "QUOTE_EXPIRED",
      "That quote request is no longer current. Please ask for a fresh quote in a new message."
    );
  }
  if (draft.checkout && unresolvedCheckoutStates.has(draft.checkout.lifecycle)) {
    throw new CommerceIntegrationError(
      "COMMERCE_CHECKOUT_ALREADY_ACTIVE",
      "Your earlier checkout is still active. Check its payment status before starting another one."
    );
  }
  requireCompleteDraft(draft);
  const quote = await createCommerceCheckoutQuote(context.business, {
    customerKey: normalizeCustomerKey(context),
    customer: {
      fullName: draft.customer.fullName!,
      email: draft.customer.email!,
      whatsappNumber: draft.notificationPhone!,
      deliveryAddress: draft.customer.deliveryAddress!,
      whatsappConsent: true
    },
    orderNotes: draft.orderNotes,
    items: draft.items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity
    }))
  });
  const updated = await CommerceShoppingDraft.findOneAndUpdate(
    {
      ...scopedDraft(context),
      version: draft.version,
      appliedActionKeys: { $ne: key }
    },
    {
      $set: {
        quote: {
          ...quote,
          expiresAt: new Date(quote.expiresAt),
          draftVersion: draft.version
        }
      },
      $unset: { checkout: "" },
      $push: { appliedActionKeys: { $each: [key], $slice: -100 } }
    },
    { new: true }
  ).select("+appliedActionKeys +checkout.idempotencyKey");
  if (!updated) {
    const current = await loadDraft(context);
    if (
      current.appliedActionKeys.includes(key) &&
      current.quote?.draftVersion === current.version &&
      current.quote.expiresAt.getTime() > Date.now()
    ) {
      return summarizeCommerceDraft(current, true);
    }
    throw new CommerceIntegrationError(
      "COMMERCE_DRAFT_CHANGED",
      "Your cart changed while the quote was being prepared. Please request a fresh quote."
    );
  }
  return summarizeCommerceDraft(updated);
};

const lifecycleFromStatus = (input: {
  paymentStatus: string;
  fulfillmentStatus: string;
}): CommerceCheckoutState["lifecycle"] => {
  if (input.paymentStatus === "paid") return "paid";
  if (input.paymentStatus === "needs_attention" || input.fulfillmentStatus === "needs_attention") {
    return "needs_attention";
  }
  if (input.paymentStatus === "refunded") return "refunded";
  if (input.paymentStatus === "failed") return "failed";
  if (input.fulfillmentStatus === "cancelled") return "expired";
  return "pending";
};

const isUnambiguousQuoteConfirmation = (message: string | undefined): boolean => {
  const normalized = message?.trim().toLowerCase().replace(/[’]/g, "'") ?? "";
  if (
    /\b(?:no|not|don't|dont|do not|never|cancel|stop|wait|later)\b/.test(normalized) ||
    /\b(?:if|unless|provided|as long as|but only)\b/.test(normalized)
  ) {
    return false;
  }
  return /^(?:i\s+confirm(?:\s+(?:this|the|my)\s+quote)?|confirm\s+(?:this|the|my)\s+quote|yes,?\s+proceed(?:\s+(?:to|with)\s+payment)?|proceed\s+(?:to|with)\s+payment|go\s+ahead\s+with\s+(?:the\s+)?payment)[.!]*$/.test(
    normalized
  );
};

const saveCheckoutResponse = async (
  context: CommerceToolExecutionContext,
  checkout: CommerceCheckoutState,
  response: {
    sessionId: string;
    orderNumber: string;
    amountPesewas: number;
    currency: "GHS";
    paymentStatus: string;
    fulfillmentStatus: string;
    paymentUrl?: string;
    deliveryFeeStatus?: string;
    receipt?: { number?: string; url?: string };
  }
) => {
  const setFields: Record<string, unknown> = {
    "checkout.lifecycle": lifecycleFromStatus(response),
    "checkout.sessionId": response.sessionId,
    "checkout.orderNumber": response.orderNumber,
    "checkout.amountPesewas": response.amountPesewas,
    "checkout.currency": response.currency,
    "checkout.paymentStatus": response.paymentStatus,
    "checkout.fulfillmentStatus": response.fulfillmentStatus,
    "checkout.lastCheckedAt": new Date()
  };
  if (response.paymentUrl !== undefined) {
    setFields["checkout.paymentUrl"] = response.paymentUrl;
  }
  if (response.deliveryFeeStatus !== undefined) {
    setFields["checkout.deliveryFeeStatus"] = response.deliveryFeeStatus;
  }
  if (response.receipt?.number !== undefined) {
    setFields["checkout.receipt.number"] = response.receipt.number;
  }
  if (response.receipt?.url !== undefined) {
    setFields["checkout.receipt.url"] = response.receipt.url;
  }
  const draft = await CommerceShoppingDraft.findOneAndUpdate(
    { ...scopedDraft(context), "checkout.idempotencyKey": checkout.idempotencyKey },
    {
      $set: setFields,
      $unset: { "checkout.lastErrorCode": "" }
    },
    { new: true }
  ).select("+appliedActionKeys +checkout.idempotencyKey");
  if (!draft) throw new Error("Checkout state could not be saved");
  return summarizeCommerceDraft(draft);
};

const resumeCheckout = async (
  context: CommerceToolExecutionContext,
  draft: ICommerceShoppingDraftDocument
) => {
  const checkout = draft.checkout;
  if (!checkout) throw new Error("Checkout state is missing");
  try {
    const response = await createCommerceCheckoutSession(
      context.business,
      { quoteId: checkout.quoteId, customerKey: normalizeCustomerKey(context) },
      checkout.idempotencyKey
    );
    return saveCheckoutResponse(context, checkout, response);
  } catch (error) {
    if (error instanceof CommerceIntegrationError) {
      const definitiveFailureCodes = new Set([
        "ORDERBRIDGE_CHECKOUT_NOT_ENABLED",
        "ORDERBRIDGE_CHECKOUT_NOT_CONFIGURED",
        "QUOTE_NOT_FOUND",
        "QUOTE_ACCESS_DENIED",
        "QUOTE_ALREADY_BOUND",
        "PRODUCT_UNAVAILABLE",
        "INSUFFICIENT_STOCK",
        "CHECKOUT_INITIALIZATION_FAILED",
        "PAYSTACK_NOT_CONFIGURED",
        "PAYSTACK_INVALID_CONFIGURATION",
        "PAYSTACK_AUTHENTICATION_FAILED",
        "PAYSTACK_INITIALIZATION_REJECTED",
        "PAYSTACK_INITIALIZATION_FAILED"
      ]);
      const lifecycle: CommerceCheckoutState["lifecycle"] =
        error.code === "CHECKOUT_EXPIRED" || error.code === "QUOTE_EXPIRED" || error.code === "QUOTE_CHANGED"
          ? "expired"
          : error.code === "QUOTE_BINDING_LOST" || error.code === "IDEMPOTENCY_KEY_CONFLICT"
            ? "needs_attention"
            : definitiveFailureCodes.has(error.code)
              ? "failed"
              : "uncertain";
      await CommerceShoppingDraft.updateOne(
        { ...scopedDraft(context), "checkout.idempotencyKey": checkout.idempotencyKey },
        { $set: { "checkout.lifecycle": lifecycle, "checkout.lastErrorCode": error.code } }
      );
    } else {
      await CommerceShoppingDraft.updateOne(
        { ...scopedDraft(context), "checkout.idempotencyKey": checkout.idempotencyKey },
        {
          $set: {
            "checkout.lifecycle": "uncertain",
            "checkout.lastErrorCode": "COMMERCE_CHECKOUT_UNKNOWN_ERROR"
          }
        }
      );
      throw new CommerceIntegrationError(
        "COMMERCE_CHECKOUT_UNKNOWN_ERROR",
        "Payment setup has an uncertain outcome. The original attempt was retained for recovery."
      );
    }
    throw error;
  }
};

export const confirmCommerceDraftCheckout = async (
  context: CommerceToolExecutionContext
) => {
  let draft = await loadDraft(context);
  if (
    draft.checkout &&
    ["initializing", "uncertain"].includes(draft.checkout.lifecycle)
  ) {
    return resumeCheckout(context, draft);
  }
  if (
    draft.checkout &&
    ["pending", "paid", "refunded", "needs_attention"].includes(
      draft.checkout.lifecycle
    )
  ) {
    return summarizeCommerceDraft(draft, true);
  }
  if (draft.checkout) {
    throw new CommerceIntegrationError(
      "COMMERCE_FRESH_QUOTE_REQUIRED",
      "That checkout can’t be reused. Please request and confirm a fresh quote."
    );
  }
  if (
    !draft.quote ||
    draft.quote.draftVersion !== draft.version ||
    draft.quote.expiresAt.getTime() <= Date.now()
  ) {
    throw new CommerceIntegrationError(
      "COMMERCE_QUOTE_CONFIRMATION_REQUIRED",
      "That quote is missing, changed, or expired. Please request and confirm a fresh quote."
    );
  }
  const customerRequestId = context.requestId?.trim();
  const presentation = draft.quote.presentation;
  if (
    !customerRequestId ||
    !presentation ||
    !presentation.outboundMessageId ||
    presentation.customerRequestId === customerRequestId ||
    !isUnambiguousQuoteConfirmation(context.originalMessage)
  ) {
    throw new CommerceIntegrationError(
      "COMMERCE_EXPLICIT_CONFIRMATION_REQUIRED",
      "Please confirm the exact displayed quote in a later message without conditions or negation."
    );
  }
  const idempotencyKey = randomUUID();
  const checkoutClaim = await CommerceShoppingDraft.findOneAndUpdate(
    {
      ...scopedDraft(context),
      version: draft.version,
      "quote.quoteId": draft.quote.quoteId,
      "quote.draftVersion": draft.version,
      "quote.expiresAt": { $gt: new Date() },
      "quote.presentation.assistantTurnId": presentation.assistantTurnId,
      "quote.presentation.customerRequestId": presentation.customerRequestId,
      "quote.presentation.outboundMessageId": presentation.outboundMessageId,
      "quote.confirmation": { $exists: false },
      checkout: { $exists: false }
    },
    {
      $set: {
        "quote.confirmation": {
          assistantTurnId: presentation.assistantTurnId,
          customerRequestId,
          confirmedAt: new Date()
        },
        checkout: {
          quoteId: draft.quote.quoteId,
          idempotencyKey,
          lifecycle: "initializing"
        }
      }
    },
    { new: true }
  ).select("+appliedActionKeys +checkout.idempotencyKey");
  if (!checkoutClaim) {
    throw new CommerceIntegrationError(
      "COMMERCE_CHECKOUT_CONFLICT",
      "The quote changed or another checkout is already active."
    );
  }
  draft = checkoutClaim;
  return resumeCheckout(context, draft);
};

export const checkCommerceDraftPaymentStatus = async (
  context: CommerceToolExecutionContext
) => {
  const draft = await loadDraft(context);
  if (!draft.checkout) {
    throw new CommerceIntegrationError(
      "COMMERCE_CHECKOUT_NOT_FOUND",
      "There is no checkout to check yet."
    );
  }
  if (!draft.checkout.sessionId) {
    return ["initializing", "uncertain", "pending"].includes(
      draft.checkout.lifecycle
    )
      ? resumeCheckout(context, draft)
      : summarizeCommerceDraft(draft);
  }
  try {
    const status = await getCommerceCheckoutStatus(
      context.business,
      draft.checkout.sessionId,
      normalizeCustomerKey(context)
    );
    return saveCheckoutResponse(context, draft.checkout, status);
  } catch (error) {
    if (error instanceof CommerceIntegrationError && error.code === "CHECKOUT_EXPIRED") {
      await CommerceShoppingDraft.updateOne(
        scopedDraft(context),
        { $set: { "checkout.lifecycle": "expired", "checkout.lastErrorCode": error.code } }
      );
    }
    throw error;
  }
};
