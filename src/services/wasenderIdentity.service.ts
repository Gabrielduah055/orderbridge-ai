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
  customerPhone?: string;
  customerAddress?: string;
  lid?: string;
  username?: string;
  recipientAddress?: string;
  addressingMode: "pn" | "lid" | "username";
  resolutionSource: WasenderIdentityResolutionSource;
}

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

  const existing = await CustomerChannelIdentity.findOne({
    restaurantId,
    provider: "wasender",
    channel: "whatsapp",
    lid: normalizedLid
  });

  if (
    existing?.phone &&
    normalizedPhone &&
    existing.phone !== normalizedPhone
  ) {
    throw new Error("WhatsApp LID is already mapped to a different customer phone");
  }

  if (
    existing?.username &&
    normalizedUsername &&
    existing.username !== normalizedUsername
  ) {
    throw new Error("WhatsApp LID is already mapped to a different username");
  }

  if (existing) {
    if (normalizedPhone && !existing.phone) {
      existing.phone = normalizedPhone;
      await existing.save();
    }

    if (normalizedUsername && !existing.username) {
      existing.username = normalizedUsername;
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

    const concurrentlyCreated = await CustomerChannelIdentity.findOne({
      restaurantId,
      provider: "wasender",
      channel: "whatsapp",
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

    if (
      concurrentlyCreated.username &&
      normalizedUsername &&
      concurrentlyCreated.username !== normalizedUsername
    ) {
      throw new Error("WhatsApp LID is already mapped to a different username");
    }

    if (normalizedPhone && !concurrentlyCreated.phone) {
      concurrentlyCreated.phone = normalizedPhone;
      await concurrentlyCreated.save();
    }

    if (normalizedUsername && !concurrentlyCreated.username) {
      concurrentlyCreated.username = normalizedUsername;
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
    return {
      customerPhone: storedPhone,
      customerAddress: storedPhone,
      lid,
      username: storedUsername || undefined,
      recipientAddress: storedPhone,
      addressingMode: "lid",
      resolutionSource: "stored_mapping"
    };
  }

  if (storedUsername) {
    return {
      customerAddress: storedUsername,
      lid,
      username: storedUsername,
      recipientAddress: storedUsername,
      addressingMode: "username",
      resolutionSource: "stored_username"
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
        customerPhone: resolvedPhone,
        customerAddress: resolvedPhone,
        lid,
        recipientAddress: resolvedPhone,
        addressingMode: "lid",
        resolutionSource: "provider_lookup"
      };
    }
  }

  if (username) {
    await remember(restaurantId, lid, undefined, username);

    return {
      customerAddress: username,
      lid,
      username,
      recipientAddress: username,
      addressingMode: "username",
      resolutionSource: "username_field"
    };
  }

  const usernameResolution = await fetchUsername(lid, { apiKey });
  const resolvedUsername = usernameResolution.success
    ? normalizeWhatsappUsername(usernameResolution.username)
    : "";

  if (resolvedUsername) {
    await remember(restaurantId, lid, undefined, resolvedUsername);

    return {
      customerAddress: resolvedUsername,
      lid,
      username: resolvedUsername,
      recipientAddress: resolvedUsername,
      addressingMode: "username",
      resolutionSource: "provider_username_lookup"
    };
  }

  await remember(restaurantId, lid);

  return {
    lid,
    addressingMode: "lid",
    resolutionSource: "lid_only"
  };
};
