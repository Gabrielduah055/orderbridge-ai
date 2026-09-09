import type { ICustomerChannelIdentityDocument } from "../models/customerChannelIdentity.model";
import { CustomerChannelIdentity } from "../models/customerChannelIdentity.model";
import type { NormalizedWasenderWebhook } from "./wasender.service";
import {
  normalizeWhatsappLid,
  resolveWasenderPhoneFromLid,
  resolveWasenderUsername
} from "./wasender.service";
import {
  normalizeGhanaPhone,
  normalizeWhatsappUsername
} from "../utils/phone.util";

export type WasenderIdentityResolutionSource =
  | "phone_field"
  | "stored_mapping"
  | "provider_lookup"
  | "username_field"
  | "stored_username"
  | "provider_username_lookup"
  | "lid_only";

export interface ResolvedWasenderCustomerIdentity {
  customerKey: string;
  customerPhone?: string;
  customerAddress?: string;
  lid?: string;
  username?: string;
  recipientAddress?: string;
  addressingMode: "pn" | "lid" | "username";
  resolutionSource: WasenderIdentityResolutionSource;
}

export const buildWasenderCustomerKey = (lid: string): string => {
  const normalizedLid = normalizeWhatsappLid(lid);
  return normalizedLid ? `wasender:lid:${normalizedLid}` : "";
};

type StoredWasenderIdentity = Pick<
  ICustomerChannelIdentityDocument,
  "phone" | "lid" | "username"
>;

export interface ResolveWasenderCustomerIdentityDependencies {
  findByLid?: (
    restaurantId: string,
    lid: string
  ) => Promise<StoredWasenderIdentity | null>;
  remember?: (
    restaurantId: string,
    lid: string,
    phone?: string,
    username?: string
  ) => Promise<StoredWasenderIdentity>;
  resolvePhoneFromLid?: typeof resolveWasenderPhoneFromLid;
  resolveUsername?: typeof resolveWasenderUsername;
}

const findStoredWasenderIdentity = async (
  restaurantId: string,
  lid: string
): Promise<StoredWasenderIdentity | null> => {
  return CustomerChannelIdentity.findOne({
    restaurantId,
    provider: "wasender",
    channel: "whatsapp",
    lid
  });
};

export const rememberWasenderCustomerIdentity = async (
  restaurantId: string,
  lid: string,
  phone?: string,
  username?: string
): Promise<StoredWasenderIdentity> => {
  const normalizedLid = normalizeWhatsappLid(lid);
  const normalizedPhone = phone && !normalizeWhatsappUsername(phone)
    ? normalizeGhanaPhone(phone)
    : "";
  const normalizedUsername = normalizeWhatsappUsername(username);

  if (!normalizedLid) {
    throw new Error("Cannot persist an invalid WhatsApp LID");
  }

  const identityScope = {
    restaurantId,
    provider: "wasender" as const,
    channel: "whatsapp" as const
  };

  // Usernames are mutable and reusable. A fresh provider username belongs to
  // the current trusted LID, so release any stale tenant-local association
  // before assigning it.
  const releaseStaleUsername = async (): Promise<void> => {
    if (!normalizedUsername) {
      return;
    }

    await CustomerChannelIdentity.updateMany(
      {
        ...identityScope,
        username: normalizedUsername,
        lid: { $ne: normalizedLid }
      },
      { $unset: { username: "" } }
    );
  };

  await releaseStaleUsername();

  const existing = await CustomerChannelIdentity.findOne({
    ...identityScope,
    lid: normalizedLid
  });

  if (
    existing?.phone &&
    normalizedPhone &&
    existing.phone !== normalizedPhone
  ) {
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

    if (changed) {
      await existing.save();
    }

    return existing;
  }

  try {
    return await CustomerChannelIdentity.create({
      restaurantId,
      provider: "wasender",
      channel: "whatsapp",
      lid: normalizedLid,
      ...(normalizedPhone ? { phone: normalizedPhone } : {}),
      ...(normalizedUsername ? { username: normalizedUsername } : {})
    });
  } catch (error) {
    const isDuplicateKey =
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: number }).code === 11000;

    if (!isDuplicateKey) {
      throw error;
    }

    await releaseStaleUsername();

    const concurrentlyCreated = await CustomerChannelIdentity.findOne({
      ...identityScope,
      lid: normalizedLid
    });

    if (!concurrentlyCreated) {
      throw error;
    }

    if (
      concurrentlyCreated.phone &&
      normalizedPhone &&
      concurrentlyCreated.phone !== normalizedPhone
    ) {
      throw new Error("WhatsApp LID is already mapped to a different customer phone");
    }

    let changed = false;
    if (normalizedPhone && !concurrentlyCreated.phone) {
      concurrentlyCreated.phone = normalizedPhone;
      changed = true;
    }

    if (
      normalizedUsername &&
      concurrentlyCreated.username !== normalizedUsername
    ) {
      concurrentlyCreated.username = normalizedUsername;
      changed = true;
    }

    if (changed) {
      await concurrentlyCreated.save();
    }

    return concurrentlyCreated;
  }
};

export const resolveWasenderCustomerIdentity = async (
  restaurantId: string,
  webhook: NormalizedWasenderWebhook,
  apiKey?: string,
  dependencies: ResolveWasenderCustomerIdentityDependencies = {}
): Promise<ResolvedWasenderCustomerIdentity> => {
  const findByLid = dependencies.findByLid ?? findStoredWasenderIdentity;
  const remember = dependencies.remember ?? rememberWasenderCustomerIdentity;
  const resolvePhoneFromLid =
    dependencies.resolvePhoneFromLid ?? resolveWasenderPhoneFromLid;
  const fetchUsername = dependencies.resolveUsername ?? resolveWasenderUsername;
  const lid = normalizeWhatsappLid(webhook.senderLid);
  const phone = webhook.senderPhone
    ? normalizeGhanaPhone(webhook.senderPhone)
    : "";
  const username = normalizeWhatsappUsername(webhook.senderUsername);

  if (phone) {
    if (lid) {
      if (username) {
        await remember(restaurantId, lid, phone, username);
      } else {
        await remember(restaurantId, lid, phone);
      }
    }

    return {
      customerKey: lid ? buildWasenderCustomerKey(lid) : phone,
      customerPhone: phone,
      customerAddress: phone,
      lid: lid || undefined,
      username: username || undefined,
      recipientAddress: phone,
      addressingMode: webhook.addressingMode === "lid" && lid ? "lid" : "pn",
      resolutionSource: "phone_field"
    };
  }

  if (!lid) {
    if (username) {
      return {
        customerKey: username,
        customerAddress: username,
        username,
        recipientAddress: username,
        addressingMode: "username",
        resolutionSource: "username_field"
      };
    }

    throw new Error("Wasender webhook has no trusted sender phone or WhatsApp LID");
  }

  const storedIdentity = await findByLid(restaurantId, lid);
  const storedPhone = storedIdentity?.phone
    ? normalizeGhanaPhone(storedIdentity.phone)
    : "";
  const storedUsername = normalizeWhatsappUsername(storedIdentity?.username);

  if (storedPhone) {
    if (username && username !== storedUsername) {
      await remember(restaurantId, lid, storedPhone, username);
    }

    return {
      customerKey: buildWasenderCustomerKey(lid),
      customerPhone: storedPhone,
      customerAddress: storedPhone,
      lid,
      username: username || storedUsername || undefined,
      recipientAddress: storedPhone,
      addressingMode: "lid",
      resolutionSource: "stored_mapping"
    };
  }

  if (username) {
    await remember(restaurantId, lid, undefined, username);

    return {
      customerKey: buildWasenderCustomerKey(lid),
      customerAddress: username,
      lid,
      username,
      recipientAddress: username,
      addressingMode: "username",
      resolutionSource: "username_field"
    };
  }

  const providerResolution = await resolvePhoneFromLid(lid, { apiKey });

  if (providerResolution.success && providerResolution.phone) {
    const resolvedPhone = normalizeGhanaPhone(providerResolution.phone);

    if (resolvedPhone) {
      if (username) {
        await remember(restaurantId, lid, resolvedPhone, username);
      } else {
        await remember(restaurantId, lid, resolvedPhone);
      }

      return {
        customerKey: buildWasenderCustomerKey(lid),
        customerPhone: resolvedPhone,
        customerAddress: resolvedPhone,
        lid,
        recipientAddress: resolvedPhone,
        addressingMode: "lid",
        resolutionSource: "provider_lookup"
      };
    }
  }

  const usernameResolution = await fetchUsername(lid, { apiKey });
  const resolvedUsername = usernameResolution.success
    ? normalizeWhatsappUsername(usernameResolution.username)
    : "";

  if (resolvedUsername) {
    await remember(restaurantId, lid, undefined, resolvedUsername);

    return {
      customerKey: buildWasenderCustomerKey(lid),
      customerAddress: resolvedUsername,
      lid,
      username: resolvedUsername,
      recipientAddress: resolvedUsername,
      addressingMode: "username",
      resolutionSource: "provider_username_lookup"
    };
  }

  if (storedUsername) {
    return {
      customerKey: buildWasenderCustomerKey(lid),
      customerAddress: storedUsername,
      lid,
      username: storedUsername,
      recipientAddress: storedUsername,
      addressingMode: "username",
      resolutionSource: "stored_username"
    };
  }

  await remember(restaurantId, lid);

  return {
    customerKey: buildWasenderCustomerKey(lid),
    lid,
    addressingMode: "lid",
    resolutionSource: "lid_only"
  };
};
