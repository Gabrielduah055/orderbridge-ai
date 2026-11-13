import { z } from "zod";
import type {
  CommerceIntegrationConfiguration,
  IBusinessDocument
} from "../models/business.model";

const maxResponseBytes = 512 * 1024;

const productSchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    name: z.string().trim().min(1).max(300),
    description: z.string().trim().max(4_000).optional(),
    price: z.number().nonnegative(),
    currency: z.string().trim().min(3).max(8).default("GHS"),
    available: z.boolean(),
    stockQuantity: z.number().int().nonnegative().optional(),
    specifications: z
      .record(z.union([z.string(), z.number(), z.boolean()]))
      .refine((value) => Object.keys(value).length <= 50, "Too many specifications")
      .optional(),
    canonicalUrl: z.string().url()
  });

const searchResponseSchema = z
  .object({
    products: z.array(productSchema).max(20),
    total: z.number().int().nonnegative().optional()
  })
  .refine(
    (value) => value.total === undefined || value.total >= value.products.length,
    { path: ["total"], message: "Total cannot be smaller than returned products" }
  );

const catalogOverviewResponseSchema = z
  .object({
    categories: z.array(z.string().trim().min(1).max(120)).max(100),
    products: z.array(productSchema).max(10),
    totalCategories: z.number().int().nonnegative(),
    totalProducts: z.number().int().nonnegative()
  })
  .strict()
  .superRefine((value, context) => {
    const normalizedCategories = value.categories.map((category) =>
      category.toLocaleLowerCase("en")
    );
    if (new Set(normalizedCategories).size !== normalizedCategories.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["categories"],
        message: "Categories must be unique"
      });
    }
    const productIds = value.products.map((product) => product.id);
    if (new Set(productIds).size !== productIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["products"],
        message: "Products must be unique"
      });
    }
    if (value.totalCategories < value.categories.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["totalCategories"],
        message: "Category total cannot be smaller than the returned selection"
      });
    }
    if (value.totalCategories > 0 && value.categories.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["categories"],
        message: "A nonempty category total requires a returned selection"
      });
    }
    if (
      value.totalProducts < value.products.length ||
      (value.totalProducts > 0 && value.products.length === 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["totalProducts"],
        message: "Product total does not match the returned selection"
      });
    }
  });

const productResponseSchema = z
  .object({
    product: productSchema
  });

const availabilityResponseSchema = z
  .object({
    productId: z.union([z.string(), z.number()]).transform(String),
    available: z.boolean(),
    stockQuantity: z.number().int().nonnegative().optional()
  });

const policySchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    content: z.string().trim().min(1).max(8_000),
    url: z.string().url().optional()
  });

const policiesResponseSchema = z
  .object({
    policies: z.array(policySchema).max(20)
  });

const checkoutMessageSchema = z.string().trim().min(1).max(1_000);
const checkoutItemSchema = z
  .object({
    productId: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(300),
    unitPricePesewas: z.number().int().nonnegative().safe(),
    quantity: z.number().int().min(1).max(20),
    lineTotalPesewas: z.number().int().nonnegative().safe()
  })
  .strict();
const checkoutQuoteResponseSchema = z
  .object({
    message: checkoutMessageSchema,
    data: z
      .object({
        quoteId: z.string().regex(/^[a-f\d]{24}$/i),
        items: z.array(checkoutItemSchema).min(1).max(20),
        subtotalPesewas: z.number().int().nonnegative().safe(),
        totalPesewas: z.number().int().nonnegative().safe(),
        currency: z.literal("GHS"),
        deliveryFee: z.literal("arranged_separately"),
        expiresAt: z.string().datetime()
      })
      .strict()
  })
  .strict()
  .superRefine((value, context) => {
    const total = value.data.items.reduce(
      (sum, item) => sum + item.lineTotalPesewas,
      0
    );
    for (const [index, item] of value.data.items.entries()) {
      if (item.lineTotalPesewas !== item.unitPricePesewas * item.quantity) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["data", "items", index, "lineTotalPesewas"],
          message: "Line total does not match quantity and unit price"
        });
      }
    }
    if (
      !Number.isSafeInteger(total) ||
      total !== value.data.subtotalPesewas ||
      value.data.totalPesewas !== value.data.subtotalPesewas
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["data", "totalPesewas"],
        message: "Quote totals do not match the item lines"
      });
    }
  });

const paymentStatusSchema = z.enum([
  "pending",
  "paid",
  "failed",
  "refunded",
  "needs_attention"
]);
const fulfillmentStatusSchema = z.enum([
  "awaiting_payment",
  "paid_awaiting_delivery",
  "processing",
  "out_for_delivery",
  "delivered",
  "cancelled",
  "needs_attention"
]);
const safeExternalUrlSchema = z.string().url().max(2_048).refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
}, "A credential-free HTTPS URL is required");
const checkoutSessionDataSchema = z
  .object({
    created: z.boolean(),
    sessionId: z.string().trim().min(16).max(100).regex(/^[A-Za-z0-9._-]+$/),
    orderNumber: z.string().trim().min(1).max(200),
    amountPesewas: z.number().int().nonnegative().safe(),
    currency: z.literal("GHS"),
    paymentStatus: paymentStatusSchema,
    fulfillmentStatus: fulfillmentStatusSchema,
    deliveryFee: z.literal("arranged_separately"),
    paymentUrl: safeExternalUrlSchema.optional()
  })
  .strict();
const checkoutSessionResponseSchema = z
  .object({ message: checkoutMessageSchema, data: checkoutSessionDataSchema })
  .strict();
const checkoutStatusResponseSchema = z
  .object({
    message: checkoutMessageSchema,
    data: checkoutSessionDataSchema
      .omit({ created: true, paymentUrl: true })
      .extend({
        deliveryFeeStatus: z.enum(["not_quoted", "quoted", "collected", "waived"]),
        receipt: z
          .object({
            number: z.string().trim().min(1).max(200).optional(),
            url: safeExternalUrlSchema.optional()
          })
          .strict()
          .optional()
      })
      .strict()
  })
  .strict();

const reviewLinksResponseSchema = z
  .object({
    orderNumber: z.string().trim().min(1).max(200),
    products: z
      .array(
        z
          .object({
            productId: z.union([z.string(), z.number()]).transform(String),
            name: z.string().trim().min(1).max(300),
            reviewState: z.enum(["available", "submitted"]),
            reviewUrl: z.string().url().max(2_048).nullable()
          })
          .strict()
      )
      .max(100)
  })
  .strict();

export type CommerceProduct = z.infer<typeof productSchema>;
export type CommerceCatalogOverview = z.infer<
  typeof catalogOverviewResponseSchema
>;
export type CommercePolicy = z.infer<typeof policySchema>;
export type CommerceReviewLink = z.infer<
  typeof reviewLinksResponseSchema
>["products"][number];
export type CommerceCheckoutQuote = z.infer<typeof checkoutQuoteResponseSchema>["data"];
export type CommerceCheckoutSession = z.infer<typeof checkoutSessionResponseSchema>["data"];
export type CommerceCheckoutStatus = z.infer<typeof checkoutStatusResponseSchema>["data"];

export class CommerceIntegrationError extends Error {
  constructor(
    public readonly code: string,
    public readonly safeMessage: string
  ) {
    super(safeMessage);
    this.name = "CommerceIntegrationError";
  }
}

export interface CommerceIntegrationDependencies {
  fetch?: typeof fetch;
}

export interface CommerceProductSearchFilters {
  minPrice?: number;
  maxPrice?: number;
  category?: string;
  available?: boolean;
  preferences?: string[];
  sort?: "relevance" | "price_asc" | "price_desc";
}

export type CommerceConnectionCheckName = "productSearch" | "policies";

export interface CommerceConnectionCheckResult {
  name: CommerceConnectionCheckName;
  success: boolean;
  details?: string;
  error?: string;
}

export interface CommerceConnectionTestResult {
  checkedAt: string;
  checks: CommerceConnectionCheckResult[];
}

const getConfiguration = (
  business: IBusinessDocument
): CommerceIntegrationConfiguration => {
  const configuration = business.commerceIntegration;

  if (!configuration?.baseUrl || !configuration.apiKey?.trim()) {
    throw new CommerceIntegrationError(
      "COMMERCE_INTEGRATION_NOT_CONFIGURED",
      "Product information is temporarily unavailable."
    );
  }

  return configuration;
};

const buildApiUrl = (
  configuration: CommerceIntegrationConfiguration,
  configuredPath: string,
  productId?: string
): URL => {
  const base = new URL(configuration.baseUrl);
  const path = productId
    ? configuredPath.replace("{productId}", encodeURIComponent(productId))
    : configuredPath;

  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new CommerceIntegrationError(
      "COMMERCE_INTEGRATION_INVALID_CONFIGURATION",
      "Product information is temporarily unavailable."
    );
  }

  const url = new URL(path, base);

  if (url.protocol !== "https:" || url.origin !== base.origin) {
    throw new CommerceIntegrationError(
      "COMMERCE_INTEGRATION_INVALID_CONFIGURATION",
      "Product information is temporarily unavailable."
    );
  }

  return url;
};

const buildHeaders = (
  configuration: CommerceIntegrationConfiguration,
  forceBearer = false
): Record<string, string> => {
  const apiKey = configuration.apiKey?.trim();

  if (!apiKey) {
    throw new CommerceIntegrationError(
      "COMMERCE_INTEGRATION_NOT_CONFIGURED",
      "Product information is temporarily unavailable."
    );
  }

  if (forceBearer || configuration.authType === "bearer") {
    return { Accept: "application/json", Authorization: `Bearer ${apiKey}` };
  }

  const headerName = configuration.apiKeyHeader?.trim() || "x-api-key";

  if (!/^[A-Za-z0-9-]{1,80}$/.test(headerName)) {
    throw new CommerceIntegrationError(
      "COMMERCE_INTEGRATION_INVALID_CONFIGURATION",
      "Product information is temporarily unavailable."
    );
  }

  return { Accept: "application/json", [headerName]: apiKey };
};

const requestJson = async (
  business: IBusinessDocument,
  path: string,
  dependencies: CommerceIntegrationDependencies,
  configureUrl?: (url: URL) => void,
  productId?: string,
  requestOptions: {
    method?: "GET" | "POST";
    forceBearer?: boolean;
  } = {}
): Promise<unknown> => {
  const configuration = getConfiguration(business);
  const url = buildApiUrl(configuration, path, productId);
  configureUrl?.(url);
  const controller = new AbortController();
  const timeoutMs = Math.min(Math.max(configuration.timeoutMs || 5_000, 500), 15_000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await (dependencies.fetch ?? fetch)(url, {
      method: requestOptions.method ?? "GET",
      headers: buildHeaders(configuration, requestOptions.forceBearer),
      signal: controller.signal,
      redirect: "error"
    });

    if (!response.ok) {
      console.warn("Commerce API request failed", {
        businessId: String(business._id),
        status: response.status
      });
      throw new CommerceIntegrationError(
        "COMMERCE_PROVIDER_UNAVAILABLE",
        "Product information is temporarily unavailable."
      );
    }

    const announcedLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(announcedLength) && announcedLength > maxResponseBytes) {
      throw new CommerceIntegrationError(
        "COMMERCE_RESPONSE_TOO_LARGE",
        "Product information is temporarily unavailable."
      );
    }

    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > maxResponseBytes) {
      throw new CommerceIntegrationError(
        "COMMERCE_RESPONSE_TOO_LARGE",
        "Product information is temporarily unavailable."
      );
    }

    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new CommerceIntegrationError(
        "COMMERCE_RESPONSE_INVALID",
        "Product information is temporarily unavailable."
      );
    }
  } catch (error) {
    if (error instanceof CommerceIntegrationError) {
      throw error;
    }

    const code = error instanceof Error && error.name === "AbortError"
      ? "COMMERCE_PROVIDER_TIMEOUT"
      : "COMMERCE_PROVIDER_UNAVAILABLE";
    throw new CommerceIntegrationError(code, "Product information is temporarily unavailable.");
  } finally {
    clearTimeout(timeout);
  }
};

const checkoutPaths = {
  quotes: "/api/integrations/orderbridge/checkout/quotes",
  sessions: "/api/integrations/orderbridge/checkout/sessions"
} as const;

const requestCheckoutJson = async (
  business: IBusinessDocument,
  path: string,
  input: {
    method: "GET" | "POST";
    body?: unknown;
    idempotencyKey?: string;
    configureUrl?: (url: URL) => void;
  },
  dependencies: CommerceIntegrationDependencies = {}
): Promise<unknown> => {
  const configuration = getConfiguration(business);
  const url = buildApiUrl(configuration, path);
  input.configureUrl?.(url);
  const controller = new AbortController();
  const timeoutMs = Math.min(Math.max(configuration.timeoutMs || 5_000, 500), 15_000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (dependencies.fetch ?? fetch)(url, {
      method: input.method,
      headers: {
        ...buildHeaders(configuration, true),
        ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {})
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: controller.signal,
      redirect: "error"
    });
    const announcedLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(announcedLength) && announcedLength > maxResponseBytes) {
      throw new CommerceIntegrationError(
        "COMMERCE_RESPONSE_TOO_LARGE",
        "Checkout information is temporarily unavailable."
      );
    }
    const rawBody = await response.text();
    if (Buffer.byteLength(rawBody, "utf8") > maxResponseBytes) {
      throw new CommerceIntegrationError(
        "COMMERCE_RESPONSE_TOO_LARGE",
        "Checkout information is temporarily unavailable."
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody) as unknown;
    } catch {
      throw new CommerceIntegrationError(
        "COMMERCE_CHECKOUT_RESPONSE_INVALID",
        "Checkout information is temporarily unavailable."
      );
    }
    if (!response.ok) {
      const source = payload && typeof payload === "object"
        ? payload as Record<string, unknown>
        : {};
      const error = source.error && typeof source.error === "object"
        ? source.error as Record<string, unknown>
        : {};
      const providerCode = typeof error.code === "string" && /^[A-Z0-9_]{3,80}$/.test(error.code)
        ? error.code
        : "COMMERCE_CHECKOUT_UNAVAILABLE";
      const recoverableCodes = new Set([
        "CHECKOUT_INITIALIZATION_UNCERTAIN",
        "CHECKOUT_INITIALIZING",
        "CHECKOUT_EXPIRED",
        "QUOTE_EXPIRED",
        "QUOTE_CHANGED",
        "PRODUCT_UNAVAILABLE",
        "INSUFFICIENT_STOCK"
      ]);
      throw new CommerceIntegrationError(
        providerCode,
        recoverableCodes.has(providerCode)
          ? typeof error.message === "string" && error.message.trim().length <= 500
            ? error.message.trim()
            : "The checkout needs to be refreshed or resumed."
          : "Checkout information is temporarily unavailable."
      );
    }
    return payload;
  } catch (error) {
    if (error instanceof CommerceIntegrationError) throw error;
    const code = error instanceof Error && error.name === "AbortError"
      ? "COMMERCE_PROVIDER_TIMEOUT"
      : "COMMERCE_PROVIDER_UNAVAILABLE";
    throw new CommerceIntegrationError(
      code,
      "Checkout information is temporarily unavailable."
    );
  } finally {
    clearTimeout(timeout);
  }
};

export const createCommerceCheckoutQuote = async (
  business: IBusinessDocument,
  input: {
    customerKey: string;
    customer: {
      fullName: string;
      email: string;
      whatsappNumber: string;
      deliveryAddress: string;
      whatsappConsent: true;
    };
    orderNotes: string;
    items: Array<{ productId: string; quantity: number }>;
  },
  dependencies: CommerceIntegrationDependencies = {}
): Promise<CommerceCheckoutQuote> => {
  const payload = await requestCheckoutJson(
    business,
    checkoutPaths.quotes,
    { method: "POST", body: input },
    dependencies
  );
  const parsed = checkoutQuoteResponseSchema.safeParse(payload);
  const expiresAt = parsed.success
    ? new Date(parsed.data.data.expiresAt).getTime()
    : Number.NaN;
  if (
    !parsed.success ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt > Date.now() + 15 * 60 * 1_000
  ) {
    throw new CommerceIntegrationError(
      "COMMERCE_CHECKOUT_RESPONSE_INVALID",
      "The checkout quote was invalid. Please try again."
    );
  }
  return parsed.data.data;
};

export const createCommerceCheckoutSession = async (
  business: IBusinessDocument,
  input: { quoteId: string; customerKey: string },
  idempotencyKey: string,
  dependencies: CommerceIntegrationDependencies = {}
): Promise<CommerceCheckoutSession> => {
  const payload = await requestCheckoutJson(
    business,
    checkoutPaths.sessions,
    { method: "POST", body: input, idempotencyKey },
    dependencies
  );
  const parsed = checkoutSessionResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new CommerceIntegrationError(
      "COMMERCE_CHECKOUT_RESPONSE_INVALID",
      "The checkout response was invalid. Please try again."
    );
  }
  return parsed.data.data;
};

export const getCommerceCheckoutStatus = async (
  business: IBusinessDocument,
  sessionId: string,
  customerKey: string,
  dependencies: CommerceIntegrationDependencies = {}
): Promise<CommerceCheckoutStatus> => {
  const path = `${checkoutPaths.sessions}/${encodeURIComponent(sessionId)}/status`;
  const payload = await requestCheckoutJson(
    business,
    path,
    {
      method: "GET",
      configureUrl: (url) => url.searchParams.set("customerKey", customerKey)
    },
    dependencies
  );
  const parsed = checkoutStatusResponseSchema.safeParse(payload);
  if (!parsed.success || parsed.data.data.sessionId !== sessionId) {
    throw new CommerceIntegrationError(
      "COMMERCE_CHECKOUT_RESPONSE_INVALID",
      "The payment status response was invalid. Please try again."
    );
  }
  return parsed.data.data;
};

export const getCommerceReviewLinks = async (
  business: IBusinessDocument,
  externalOrderId: string,
  expectedOrderNumber: string,
  expectedProducts: ReadonlyArray<{ productId: string; name: string }>,
  dependencies: CommerceIntegrationDependencies = {}
): Promise<{ orderNumber: string; products: CommerceReviewLink[] }> => {
  const configuration = getConfiguration(business);
  const reviewLinksPath =
    `/api/integrations/orderbridge/orders/${encodeURIComponent(externalOrderId)}/review-links`;
  const payload = await requestJson(
    business,
    reviewLinksPath,
    dependencies,
    undefined,
    undefined,
    { method: "POST", forceBearer: true }
  );
  const parsed = reviewLinksResponseSchema.safeParse(payload);

  if (!parsed.success || parsed.data.orderNumber !== expectedOrderNumber) {
    throw new CommerceIntegrationError(
      "COMMERCE_REVIEW_RESPONSE_INVALID",
      "Review links are temporarily unavailable."
    );
  }

  const expectedProductNames = new Map(
    expectedProducts.map((product) => [product.productId, product.name])
  );
  const seenIds = new Set<string>();
  for (const product of parsed.data.products) {
    if (
      expectedProductNames.get(product.productId) !== product.name ||
      seenIds.has(product.productId)
    ) {
      throw new CommerceIntegrationError(
        "COMMERCE_REVIEW_RESPONSE_INVALID",
        "Review links are temporarily unavailable."
      );
    }
    seenIds.add(product.productId);

    if (product.reviewUrl) {
      try {
        assertCanonicalUrl(product.reviewUrl, configuration);
      } catch {
        throw new CommerceIntegrationError(
          "COMMERCE_REVIEW_RESPONSE_INVALID",
          "Review links are temporarily unavailable."
        );
      }
    }
  }

  if (seenIds.size !== expectedProductNames.size) {
    throw new CommerceIntegrationError(
      "COMMERCE_REVIEW_RESPONSE_INVALID",
      "Review links are temporarily unavailable."
    );
  }

  return parsed.data;
};

const assertCanonicalUrl = (
  value: string,
  configuration: CommerceIntegrationConfiguration
): void => {
  const url = new URL(value);
  const allowedHosts = new Set(
    configuration.canonicalProductHosts.map((host) => host.trim().toLowerCase()).filter(Boolean)
  );

  if (
    url.protocol !== "https:" ||
    Boolean(url.username || url.password) ||
    !allowedHosts.has(url.hostname.toLowerCase())
  ) {
    throw new CommerceIntegrationError(
      "COMMERCE_RESPONSE_INVALID",
      "Product information is temporarily unavailable."
    );
  }
};

const validateProducts = (
  products: CommerceProduct[],
  configuration: CommerceIntegrationConfiguration
): CommerceProduct[] => {
  for (const product of products) {
    assertCanonicalUrl(product.canonicalUrl, configuration);
  }
  return products;
};

export const getCommerceCatalogOverview = async (
  business: IBusinessDocument,
  limit: number,
  dependencies: CommerceIntegrationDependencies = {}
): Promise<CommerceCatalogOverview> => {
  const configuration = getConfiguration(business);
  const overviewPath = configuration.paths.overview;
  if (!overviewPath) {
    throw new CommerceIntegrationError(
      "COMMERCE_INTEGRATION_INVALID_CONFIGURATION",
      "Catalog information is temporarily unavailable."
    );
  }
  const payload = await requestJson(
    business,
    overviewPath,
    dependencies,
    (url) => url.searchParams.set("limit", String(limit))
  );
  const parsed = catalogOverviewResponseSchema.safeParse(payload);

  if (!parsed.success) {
    throw new CommerceIntegrationError(
      "COMMERCE_RESPONSE_INVALID",
      "Catalog information is temporarily unavailable."
    );
  }

  return {
    ...parsed.data,
    products: validateProducts(parsed.data.products, configuration)
  };
};

export const searchCommerceProducts = async (
  business: IBusinessDocument,
  query: string | undefined,
  limit: number,
  filtersOrDependencies:
    | CommerceProductSearchFilters
    | CommerceIntegrationDependencies = {},
  explicitDependencies: CommerceIntegrationDependencies = {}
) => {
  const dependencies =
    "fetch" in filtersOrDependencies
      ? filtersOrDependencies as CommerceIntegrationDependencies
      : explicitDependencies;
  const filters =
    "fetch" in filtersOrDependencies
      ? {}
      : filtersOrDependencies as CommerceProductSearchFilters;
  const configuration = getConfiguration(business);
  const payload = await requestJson(
    business,
    configuration.paths.search,
    dependencies,
    (url) => {
      if (query?.trim()) url.searchParams.set("query", query.trim());
      url.searchParams.set("limit", String(limit));
      if (filters.minPrice !== undefined) {
        url.searchParams.set("minPrice", String(filters.minPrice));
      }
      if (filters.maxPrice !== undefined) {
        url.searchParams.set("maxPrice", String(filters.maxPrice));
      }
      if (filters.category?.trim()) {
        url.searchParams.set("category", filters.category.trim());
      }
      if (filters.available !== undefined) {
        url.searchParams.set("available", String(filters.available));
      }
      for (const preference of filters.preferences ?? []) {
        url.searchParams.append("preference", preference);
      }
      if (filters.sort) url.searchParams.set("sort", filters.sort);
    }
  );
  const parsed = searchResponseSchema.safeParse(payload);

  if (!parsed.success) {
    throw new CommerceIntegrationError(
      "COMMERCE_RESPONSE_INVALID",
      "Product information is temporarily unavailable."
    );
  }

  const products = validateProducts(parsed.data.products, configuration);
  const violatesRequestedLimit = products.length > limit;
  const violatesAvailabilityFilter =
    filters.available !== undefined &&
    products.some((product) => product.available !== filters.available);
  const violatesPriceSort =
    filters.sort === "price_asc"
      ? products.some(
          (product, index) =>
            index > 0 && products[index - 1].price > product.price
        )
      : filters.sort === "price_desc"
        ? products.some(
            (product, index) =>
              index > 0 && products[index - 1].price < product.price
          )
        : false;
  if (
    violatesRequestedLimit ||
    violatesAvailabilityFilter ||
    violatesPriceSort
  ) {
    throw new CommerceIntegrationError(
      "COMMERCE_RESPONSE_INVALID",
      "Product information is temporarily unavailable."
    );
  }

  return {
    products,
    total: parsed.data.total ?? parsed.data.products.length
  };
};

export const getCommerceProduct = async (
  business: IBusinessDocument,
  productId: string,
  dependencies: CommerceIntegrationDependencies = {}
) => {
  const configuration = getConfiguration(business);
  const payload = await requestJson(
    business,
    configuration.paths.product,
    dependencies,
    undefined,
    productId
  );
  const parsed = productResponseSchema.safeParse(payload);

  if (!parsed.success) {
    throw new CommerceIntegrationError(
      "COMMERCE_RESPONSE_INVALID",
      "Product information is temporarily unavailable."
    );
  }

  assertCanonicalUrl(parsed.data.product.canonicalUrl, configuration);
  return parsed.data;
};

export const getCommerceAvailability = async (
  business: IBusinessDocument,
  productId: string,
  dependencies: CommerceIntegrationDependencies = {}
) => {
  const configuration = getConfiguration(business);
  const payload = await requestJson(
    business,
    configuration.paths.availability,
    dependencies,
    undefined,
    productId
  );
  const parsed = availabilityResponseSchema.safeParse(payload);

  if (!parsed.success || parsed.data.productId !== productId) {
    throw new CommerceIntegrationError(
      "COMMERCE_RESPONSE_INVALID",
      "Product information is temporarily unavailable."
    );
  }

  return parsed.data;
};

export const getCommercePolicies = async (
  business: IBusinessDocument,
  topic: string | undefined,
  dependencies: CommerceIntegrationDependencies = {}
) => {
  const configuration = getConfiguration(business);
  const payload = await requestJson(
    business,
    configuration.paths.policies,
    dependencies,
    topic
      ? (url) => {
          url.searchParams.set("topic", topic);
        }
      : undefined
  );
  const parsed = policiesResponseSchema.safeParse(payload);

  if (!parsed.success) {
    throw new CommerceIntegrationError(
      "COMMERCE_RESPONSE_INVALID",
      "Business policies are temporarily unavailable."
    );
  }

  for (const policy of parsed.data.policies) {
    if (policy.url) assertCanonicalUrl(policy.url, configuration);
  }

  return parsed.data;
};

const getSafeConnectionFailure = (error: unknown): string => {
  if (!(error instanceof CommerceIntegrationError)) {
    return "The connection check could not be completed.";
  }

  switch (error.code) {
    case "COMMERCE_INTEGRATION_NOT_CONFIGURED":
      return "The saved commerce integration is not fully configured.";
    case "COMMERCE_INTEGRATION_INVALID_CONFIGURATION":
      return "The saved commerce integration configuration is invalid.";
    case "COMMERCE_PROVIDER_TIMEOUT":
      return "The provider did not respond before the configured timeout.";
    case "COMMERCE_PROVIDER_UNAVAILABLE":
      return "The provider rejected the request or is currently unavailable.";
    case "COMMERCE_RESPONSE_TOO_LARGE":
      return "The provider response exceeded the allowed size.";
    case "COMMERCE_RESPONSE_INVALID":
      return "The provider response did not match the expected contract.";
    default:
      return "The connection check could not be completed.";
  }
};

export const testCommerceConnection = async (
  business: IBusinessDocument,
  searchTerm: string,
  dependencies: CommerceIntegrationDependencies = {}
): Promise<CommerceConnectionTestResult> => {
  const [productSearch, policies] = await Promise.all([
    searchCommerceProducts(business, searchTerm, 1, dependencies)
      .then<CommerceConnectionCheckResult>((result) => ({
        name: "productSearch",
        success: true,
        details: result.products.length === 0
          ? "Product search returned a valid empty product list."
          : "Product search returned a valid product."
      }))
      .catch<CommerceConnectionCheckResult>((error: unknown) => ({
        name: "productSearch",
        success: false,
        error: getSafeConnectionFailure(error)
      })),
    getCommercePolicies(business, undefined, dependencies)
      .then<CommerceConnectionCheckResult>((result) => ({
        name: "policies",
        success: true,
        details: result.policies.length === 0
          ? "Policies returned a valid empty list."
          : "Policies returned a valid response."
      }))
      .catch<CommerceConnectionCheckResult>((error: unknown) => ({
        name: "policies",
        success: false,
        error: getSafeConnectionFailure(error)
      }))
  ]);

  return {
    checkedAt: new Date().toISOString(),
    checks: [productSearch, policies]
  };
};
