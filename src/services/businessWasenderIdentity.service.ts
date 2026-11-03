import type { IBusinessCustomerChannelIdentityDocument } from "../models/businessCustomerChannelIdentity.model";
import { BusinessCustomerChannelIdentity } from "../models/businessCustomerChannelIdentity.model";
import {
  normalizeWhatsappLid,
  resolveWasenderPhoneFromLid,
  resolveWasenderUsername,
  type NormalizedWasenderWebhook,
  type WasenderLidResolutionResult,
  type WasenderUsernameResolutionResult
} from "./wasender.service";
import {
  isWhatsappPhoneAddress,
  isWhatsappUsername,
  isValidWhatsappRecipient,
  normalizeGhanaPhone,
  normalizeWhatsappRecipient,
  normalizeWhatsappUsername
} from "../utils/phone.util";

const lidKeyPrefix = "wasender:lid:";

type StoredBusinessIdentity = Pick<
  IBusinessCustomerChannelIdentityDocument,
  "phone" | "lid" | "username"
>;

export interface ResolvedBusinessWasenderIdentity {
  customerKey: string;
  recipientAddress: string;
  phone?: string;
  lid?: string;
  username?: string;
}

export interface BusinessWhatsappRecipientResolution {
  resolved: boolean;
  recipient?: string;
  reason: string;
  temporary?: boolean;
  retryAfterMs?: number;
}

export class BusinessWasenderIdentityResolutionError extends Error {
  constructor(
    public readonly reason: string,
    public readonly temporary: boolean,
    public readonly retryAfterMs?: number
  ) {
    super(reason);
    this.name = "BusinessWasenderIdentityResolutionError";
  }
}

const getProviderRetryAfterMs = (
  result: WasenderLidResolutionResult | WasenderUsernameResolutionResult
): number | undefined => {
  const data = result.data;
  if (!data || typeof data !== "object" || !("retry_after" in data)) {
    return undefined;
  }

  const retryAfter = Number((data as { retry_after?: unknown }).retry_after);
  return Number.isFinite(retryAfter) && retryAfter > 0
    ? Math.ceil(retryAfter * 1000)
    : undefined;
};

const isTemporaryProviderFailure = (
  result: WasenderLidResolutionResult | WasenderUsernameResolutionResult
): boolean =>
  !result.success &&
  (result.status === undefined || result.status === 429 || result.status >= 500);

export const buildBusinessWasenderCustomerKey = (lid: string): string => {
  const normalizedLid = normalizeWhatsappLid(lid);
  return normalizedLid ? `${lidKeyPrefix}${normalizedLid}` : "";
};

const findBusinessIdentityByLid = async (
  businessId: string,
  sessionId: string,
  lid: string
): Promise<StoredBusinessIdentity | null> =>
  BusinessCustomerChannelIdentity.findOne({
    businessId,
    sessionId,
    provider: "wasender",
    channel: "whatsapp",
    lid
  });

export const rememberBusinessWasenderIdentity = async (
  businessId: string,
  sessionId: string,
  lid: string,
  phone?: string,
  username?: string
): Promise<StoredBusinessIdentity> => {
  const normalizedLid = normalizeWhatsappLid(lid);
  const normalizedPhone = isWhatsappPhoneAddress(phone)
    ? normalizeGhanaPhone(phone!)
    : "";
  const normalizedUsername = normalizeWhatsappUsername(username);
  if (!normalizedLid) throw new Error("Cannot persist an invalid WhatsApp LID");

  const identityScope = {
    businessId,
    sessionId,
    provider: "wasender" as const,
    channel: "whatsapp" as const
  };
  if (normalizedUsername) {
    await BusinessCustomerChannelIdentity.updateMany(
      {
        ...identityScope,
        username: normalizedUsername,
        lid: { $ne: normalizedLid }
      },
      { $unset: { username: "" } }
    );
  }

  const existing = await BusinessCustomerChannelIdentity.findOne({
    ...identityScope,
    lid: normalizedLid
  });
  if (existing?.phone && normalizedPhone && existing.phone !== normalizedPhone) {
    throw new Error("WhatsApp LID is already mapped to a different customer phone");
  }
  if (existing) {
    let changed = false;
    if (normalizedPhone && !existing.phone) {
      existing.phone = normalizedPhone;
      changed = true;
    }
    if (normalizedUsername && existing.username !== normalizedUsername) {
      existing.username = normalizedUsername;
      changed = true;
    }
    if (changed) await existing.save();
    return existing;
  }

  try {
    return await BusinessCustomerChannelIdentity.create({
      ...identityScope,
      lid: normalizedLid,
      ...(normalizedPhone ? { phone: normalizedPhone } : {}),
      ...(normalizedUsername ? { username: normalizedUsername } : {})
    });
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      (error as { code?: number }).code !== 11000
    ) {
      throw error;
    }
    const concurrent = await BusinessCustomerChannelIdentity.findOne({
      ...identityScope,
      lid: normalizedLid
    });
    if (!concurrent) throw error;
    if (concurrent.phone && normalizedPhone && concurrent.phone !== normalizedPhone) {
      throw new Error("WhatsApp LID is already mapped to a different customer phone");
    }
    if (normalizedPhone && !concurrent.phone) concurrent.phone = normalizedPhone;
    if (normalizedUsername) concurrent.username = normalizedUsername;
    await concurrent.save();
    return concurrent;
  }
};

export const resolveBusinessWasenderIdentity = async (
  businessId: string,
  sessionId: string,
  webhook: NormalizedWasenderWebhook,
  apiKey: string
): Promise<ResolvedBusinessWasenderIdentity> => {
  const lid = normalizeWhatsappLid(webhook.senderLid);
  const phone = isWhatsappPhoneAddress(webhook.senderPhone)
    ? normalizeGhanaPhone(webhook.senderPhone!)
    : "";
  const username = normalizeWhatsappUsername(webhook.senderUsername);

  if (phone) {
    if (lid) await rememberBusinessWasenderIdentity(
      businessId,
      sessionId,
      lid,
      phone,
      username || undefined
    );
    return {
      customerKey: lid ? buildBusinessWasenderCustomerKey(lid) : phone,
      recipientAddress: phone,
      phone,
      lid: lid || undefined,
      username: username || undefined
    };
  }

  if (!lid) {
    if (!username) {
      throw new BusinessWasenderIdentityResolutionError(
        "sender_identity_missing",
        false
      );
    }
    return {
      customerKey: username,
      recipientAddress: username,
      username
    };
  }

  const stored = await findBusinessIdentityByLid(businessId, sessionId, lid);
  const storedPhone = isWhatsappPhoneAddress(stored?.phone)
    ? normalizeGhanaPhone(stored!.phone!)
    : "";
  const storedUsername = normalizeWhatsappUsername(stored?.username);
  if (storedPhone) {
    if (username && username !== storedUsername) {
      await rememberBusinessWasenderIdentity(
        businessId,
        sessionId,
        lid,
        storedPhone,
        username
      );
    }
    return {
      customerKey: buildBusinessWasenderCustomerKey(lid),
      recipientAddress: storedPhone,
      phone: storedPhone,
      lid,
      username: username || storedUsername || undefined
    };
  }
  if (username) {
    await rememberBusinessWasenderIdentity(
      businessId,
      sessionId,
      lid,
      undefined,
      username
    );
    return {
      customerKey: buildBusinessWasenderCustomerKey(lid),
      recipientAddress: username,
      lid,
      username
    };
  }
  if (storedUsername) {
    return {
      customerKey: buildBusinessWasenderCustomerKey(lid),
      recipientAddress: storedUsername,
      lid,
      username: storedUsername
    };
  }

  const phoneResolution = await resolveWasenderPhoneFromLid(lid, { apiKey });
  if (phoneResolution.success && isWhatsappPhoneAddress(phoneResolution.phone)) {
    const resolvedPhone = normalizeGhanaPhone(phoneResolution.phone!);
    await rememberBusinessWasenderIdentity(
      businessId,
      sessionId,
      lid,
      resolvedPhone
    );
    return {
      customerKey: buildBusinessWasenderCustomerKey(lid),
      recipientAddress: resolvedPhone,
      phone: resolvedPhone,
      lid
    };
  }

  const usernameResolution = await resolveWasenderUsername(lid, { apiKey });
  const resolvedUsernameLid = usernameResolution.jid
    ? normalizeWhatsappLid(usernameResolution.jid)
    : lid;
  const resolvedUsername = usernameResolution.success
    ? normalizeWhatsappUsername(usernameResolution.username)
    : "";
  if (resolvedUsername && resolvedUsernameLid === lid) {
    await rememberBusinessWasenderIdentity(
      businessId,
      sessionId,
      lid,
      undefined,
      resolvedUsername
    );
    return {
      customerKey: buildBusinessWasenderCustomerKey(lid),
      recipientAddress: resolvedUsername,
      lid,
      username: resolvedUsername
    };
  }

  const temporary =
    isTemporaryProviderFailure(phoneResolution) ||
    isTemporaryProviderFailure(usernameResolution);
  throw new BusinessWasenderIdentityResolutionError(
    temporary ? "sender_identity_lookup_temporary" : "sender_identity_unresolved",
    temporary,
    getProviderRetryAfterMs(usernameResolution) ??
      getProviderRetryAfterMs(phoneResolution)
  );
};

export const resolveCurrentBusinessWhatsappRecipient = async (input: {
  businessId: string;
  sessionId: string;
  customerKey: string;
  fallbackAddress: string;
  apiKey: string;
}): Promise<BusinessWhatsappRecipientResolution> => {
  const customerKey = input.customerKey.trim().toLowerCase();
  const fallback = normalizeWhatsappRecipient(input.fallbackAddress);
  if (!customerKey.startsWith(lidKeyPrefix)) {
    return isValidWhatsappRecipient(fallback)
      ? { resolved: true, recipient: fallback, reason: "direct_recipient" }
      : { resolved: false, reason: "no_routable_address" };
  }

  const lid = normalizeWhatsappLid(customerKey.slice(lidKeyPrefix.length));
  if (!lid) return { resolved: false, reason: "invalid_customer_key" };

  const stored = await findBusinessIdentityByLid(
    input.businessId,
    input.sessionId,
    lid
  );
  const phone = isWhatsappPhoneAddress(stored?.phone)
    ? normalizeGhanaPhone(stored!.phone!)
    : "";
  if (phone) return { resolved: true, recipient: phone, reason: "current_phone" };

  const usernameResolution = await resolveWasenderUsername(lid, {
    apiKey: input.apiKey
  });
  const resolvedUsernameLid = usernameResolution.jid
    ? normalizeWhatsappLid(usernameResolution.jid)
    : lid;
  const username = usernameResolution.success
    ? normalizeWhatsappUsername(usernameResolution.username)
    : "";
  if (
    username &&
    isWhatsappUsername(username) &&
    resolvedUsernameLid === lid
  ) {
    await rememberBusinessWasenderIdentity(
      input.businessId,
      input.sessionId,
      lid,
      undefined,
      username
    );
    return {
      resolved: true,
      recipient: username,
      reason: "current_username"
    };
  }
  if (isTemporaryProviderFailure(usernameResolution)) {
    return {
      resolved: false,
      reason: "username_lookup_failed",
      temporary: true,
      retryAfterMs: getProviderRetryAfterMs(usernameResolution)
    };
  }

  return {
    resolved: false,
    reason: isValidWhatsappRecipient(fallback)
      ? "stale_recipient"
      : "no_routable_address"
  };
};
