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
    whatsappConsent: draft.customer.whatsappConsent === true
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
        confirmed: Boolean(draft.quote.confirmedAt),
        current: draft.quote.draftVersion === draft.version
      }
    : undefined,
  checkout: publicCheckout(draft.checkout),
  idempotent
});

export const getCommerceDraft = async (context: CommerceToolExecutionContext) =>
  summarizeCommerceDraft(await loadDraft(context));

const mutateDraft = async (
  context: CommerceToolExecutionContext,
  action: string,
  input: unknown,
  mutate: (draft: ICommerceShoppingDraftDocument) => {
    items?: CommerceDraftItem[];
    customer?: CommerceDraftCustomer;
    orderNotes?: string;
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
    if (!draft.checkout || !unresolvedCheckoutStates.has(draft.checkout.lifecycle)) {
      update.$unset = { quote: "", checkout: "" };
    }
    const updated = await CommerceShoppingDraft.findOneAndUpdate(
      {
        ...scopedDraft(context),
        version: draft.version,
        appliedActionKeys: { $ne: key }
      },
      update,
      { new: true }
    ).select("+appliedActionKeys +checkout.idempotencyKey");
    if (updated) return summarizeCommerceDraft(updated);
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

export const updateCommerceDraftCustomer = async (
  context: CommerceToolExecutionContext,
  input: Partial<CommerceDraftCustomer> & { orderNotes?: string }
) => mutateDraft(context, "update_customer", input, (draft) => ({
  customer: {
    fullName: input.fullName ?? draft.customer.fullName,
    email: input.email ?? draft.customer.email,
    deliveryAddress: input.deliveryAddress ?? draft.customer.deliveryAddress,
    whatsappConsent: input.whatsappConsent ?? draft.customer.whatsappConsent
  },
  orderNotes: input.orderNotes ?? draft.orderNotes
}));

export const clearCommerceDraft = async (context: CommerceToolExecutionContext) =>
  mutateDraft(context, "clear", {}, () => ({ items: [], customer: {}, orderNotes: "" }));

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
  const next: CommerceCheckoutState = {
    ...checkout,
    lifecycle: lifecycleFromStatus(response),
    ...response,
    lastCheckedAt: new Date(),
    lastErrorCode: undefined
  };
  const draft = await CommerceShoppingDraft.findOneAndUpdate(
    { ...scopedDraft(context), "checkout.idempotencyKey": checkout.idempotencyKey },
    { $set: { checkout: next } },
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
      const lifecycle: CommerceCheckoutState["lifecycle"] =
        error.code === "CHECKOUT_EXPIRED" || error.code === "QUOTE_EXPIRED" || error.code === "QUOTE_CHANGED"
          ? "expired"
          : error.code === "CHECKOUT_INITIALIZATION_UNCERTAIN" ||
              error.code === "CHECKOUT_INITIALIZING" ||
              error.code === "COMMERCE_PROVIDER_TIMEOUT" ||
              error.code === "COMMERCE_PROVIDER_UNAVAILABLE" ||
              error.code === "COMMERCE_CHECKOUT_RESPONSE_INVALID" ||
              error.code === "COMMERCE_RESPONSE_TOO_LARGE"
            ? "uncertain"
            : error.code === "QUOTE_BINDING_LOST" || error.code === "IDEMPOTENCY_KEY_CONFLICT"
              ? "needs_attention"
              : "failed";
      await CommerceShoppingDraft.updateOne(
        { ...scopedDraft(context), "checkout.idempotencyKey": checkout.idempotencyKey },
        { $set: { "checkout.lifecycle": lifecycle, "checkout.lastErrorCode": error.code } }
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
  const idempotencyKey = randomUUID();
  draft = await CommerceShoppingDraft.findOneAndUpdate(
    {
      ...scopedDraft(context),
      version: draft.version,
      "quote.quoteId": draft.quote.quoteId,
      "quote.draftVersion": draft.version,
      "quote.expiresAt": { $gt: new Date() },
      checkout: { $exists: false }
    },
    {
      $set: {
        "quote.confirmedAt": new Date(),
        checkout: {
          quoteId: draft.quote.quoteId,
          idempotencyKey,
          lifecycle: "initializing"
        }
      }
    },
    { new: true }
  ).select("+appliedActionKeys +checkout.idempotencyKey");
  if (!draft) {
    throw new CommerceIntegrationError(
      "COMMERCE_CHECKOUT_CONFLICT",
      "The quote changed or another checkout is already active."
    );
  }
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
