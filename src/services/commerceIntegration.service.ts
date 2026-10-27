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

export type CommerceProduct = z.infer<typeof productSchema>;
export type CommercePolicy = z.infer<typeof policySchema>;

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
  configuration: CommerceIntegrationConfiguration
): Record<string, string> => {
  const apiKey = configuration.apiKey?.trim();

  if (!apiKey) {
    throw new CommerceIntegrationError(
      "COMMERCE_INTEGRATION_NOT_CONFIGURED",
      "Product information is temporarily unavailable."
    );
  }

  if (configuration.authType === "bearer") {
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
  productId?: string
): Promise<unknown> => {
  const configuration = getConfiguration(business);
  const url = buildApiUrl(configuration, path, productId);
  configureUrl?.(url);
  const controller = new AbortController();
  const timeoutMs = Math.min(Math.max(configuration.timeoutMs || 5_000, 500), 15_000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await (dependencies.fetch ?? fetch)(url, {
      method: "GET",
      headers: buildHeaders(configuration),
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

export const searchCommerceProducts = async (
  business: IBusinessDocument,
  query: string,
  limit: number,
  dependencies: CommerceIntegrationDependencies = {}
) => {
  const configuration = getConfiguration(business);
  const payload = await requestJson(
    business,
    configuration.paths.search,
    dependencies,
    (url) => {
      url.searchParams.set("query", query);
      url.searchParams.set("limit", String(limit));
    }
  );
  const parsed = searchResponseSchema.safeParse(payload);

  if (!parsed.success) {
    throw new CommerceIntegrationError(
      "COMMERCE_RESPONSE_INVALID",
      "Product information is temporarily unavailable."
    );
  }

  return {
    products: validateProducts(parsed.data.products, configuration),
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
