import type { ICustomerChannelIdentityDocument } from "../models/customerChannelIdentity.model";
import { CustomerChannelIdentity } from "../models/customerChannelIdentity.model";
import type { NormalizedWasenderWebhook } from "./wasender.service";
import {
  normalizeWhatsappLid,
  resolveWasenderPhoneFromLid
} from "./wasender.service";
import { normalizeGhanaPhone } from "../utils/phone.util";

export type WasenderIdentityResolutionSource =
  | "phone_field"
  | "stored_mapping"
  | "provider_lookup"
  | "lid_only";

export interface ResolvedWasenderCustomerIdentity {
  customerPhone?: string;
  lid?: string;
  recipientAddress?: string;
  addressingMode: "pn" | "lid";
  resolutionSource: WasenderIdentityResolutionSource;
}

type StoredWasenderIdentity = Pick<
  ICustomerChannelIdentityDocument,
  "phone" | "lid"
>;

export interface ResolveWasenderCustomerIdentityDependencies {
  findByLid?: (
    restaurantId: string,
    lid: string
  ) => Promise<StoredWasenderIdentity | null>;
  remember?: (
    restaurantId: string,
    lid: string,
    phone?: string
  ) => Promise<StoredWasenderIdentity>;
  resolvePhoneFromLid?: typeof resolveWasenderPhoneFromLid;
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
  phone?: string
): Promise<StoredWasenderIdentity> => {
  const normalizedLid = normalizeWhatsappLid(lid);
  const normalizedPhone = phone ? normalizeGhanaPhone(phone) : "";

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

  if (existing) {
    if (normalizedPhone && !existing.phone) {
      existing.phone = normalizedPhone;
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
      ...(normalizedPhone ? { phone: normalizedPhone } : {})
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

    if (normalizedPhone && !concurrentlyCreated.phone) {
      concurrentlyCreated.phone = normalizedPhone;
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
  const lid = normalizeWhatsappLid(webhook.senderLid);
  const phone = webhook.senderPhone
    ? normalizeGhanaPhone(webhook.senderPhone)
    : "";

  if (phone) {
    if (lid) {
      await remember(restaurantId, lid, phone);
    }

    return {
      customerPhone: phone,
      lid: lid || undefined,
      recipientAddress: phone,
      addressingMode: webhook.addressingMode === "lid" && lid ? "lid" : "pn",
      resolutionSource: "phone_field"
    };
  }

  if (!lid) {
    throw new Error("Wasender webhook has no trusted sender phone or WhatsApp LID");
  }

  const storedIdentity = await findByLid(restaurantId, lid);
  const storedPhone = storedIdentity?.phone
    ? normalizeGhanaPhone(storedIdentity.phone)
    : "";

  if (storedPhone) {
    return {
      customerPhone: storedPhone,
      lid,
      recipientAddress: storedPhone,
      addressingMode: "lid",
      resolutionSource: "stored_mapping"
    };
  }

  const providerResolution = await resolvePhoneFromLid(lid, { apiKey });

  if (providerResolution.success && providerResolution.phone) {
    const resolvedPhone = normalizeGhanaPhone(providerResolution.phone);

    if (resolvedPhone) {
      await remember(restaurantId, lid, resolvedPhone);

      return {
        customerPhone: resolvedPhone,
        lid,
        recipientAddress: resolvedPhone,
        addressingMode: "lid",
        resolutionSource: "provider_lookup"
      };
    }
  }

  await remember(restaurantId, lid);

  return {
    lid,
    addressingMode: "lid",
    resolutionSource: "lid_only"
  };
};
