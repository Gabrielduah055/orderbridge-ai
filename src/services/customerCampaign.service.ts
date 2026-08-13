import { Types, type ClientSession } from "mongoose";
import { z } from "zod";
import {
  CustomerCampaign,
  customerCampaignStatuses,
  customerCampaignTargetingTypes,
  customerCampaignTypes,
  type CustomerCampaignTargetingRule,
  type ICustomerCampaignDocument
} from "../models/customerCampaign.model";
import {
  CustomerCampaignRecipient,
  type CustomerCampaignRecipientStatus
} from "../models/customerCampaignRecipient.model";
import {
  CustomerProfile,
  type ICustomerProfileDocument
} from "../models/customerProfile.model";
import { MenuItem } from "../models/MenuItem";
import { Order } from "../models/order.model";
import { OutboundMessage } from "../models/outboundMessage.model";
import { PendingAgentAction } from "../models/pendingAgentAction.model";
import {
  Restaurant,
  type IRestaurantDocument
} from "../models/Restaurant";
import type { SenderRole } from "../types/agent.types";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError
} from "../utils/httpErrors";
import { normalizeGhanaPhone } from "../utils/phone.util";
import { resolveZonedDateTime } from "../utils/zonedDateTime.util";
import { isCustomerEligibleForMarketing } from "./customerMarketingPreference.service";
import { resolveSenderIdentity } from "./senderIdentity.service";

const campaignTargetingBaseSchema = z
  .object({
    type: z.enum(customerCampaignTargetingTypes),
    inactiveDays: z.number().int().min(1).max(3650).optional(),
    menuItemId: z.string().trim().min(1).optional(),
    startDate: z.string().datetime({ offset: true }).optional(),
    endDate: z.string().datetime({ offset: true }).optional()
  })
  .strict();

export const customerCampaignTargetingSchema =
  campaignTargetingBaseSchema.superRefine((value, context) => {
    const allowedFieldsByType: Record<
      (typeof customerCampaignTargetingTypes)[number],
      string[]
    > = {
      all_eligible_customers: [],
      inactive_customers: ["inactiveDays"],
      returning_customers: [],
      ordered_menu_item: ["menuItemId"],
      last_order_date_range: ["startDate", "endDate"]
    };
    const optionalTargetingFields = [
      "inactiveDays",
      "menuItemId",
      "startDate",
      "endDate"
    ] as const;

    for (const field of optionalTargetingFields) {
      if (
        value[field] !== undefined &&
        !allowedFieldsByType[value.type].includes(field)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} is not allowed for ${value.type}`
        });
      }
    }

    if (value.type === "inactive_customers" && !value.inactiveDays) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["inactiveDays"],
        message: "inactiveDays is required"
      });
    }

    if (value.type === "ordered_menu_item" && !value.menuItemId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["menuItemId"],
        message: "menuItemId is required"
      });
    }

    if (
      value.type === "last_order_date_range" &&
      (!value.startDate || !value.endDate)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["startDate"],
        message: "startDate and endDate are required"
      });
    }

    if (
      value.startDate &&
      value.endDate &&
      new Date(value.startDate) > new Date(value.endDate)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endDate"],
        message: "endDate must be on or after startDate"
      });
    }
  });

export const createCustomerCampaignDraftSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    message: z.string().trim().min(1).max(2000),
    campaignType: z.enum(customerCampaignTypes),
    targeting: customerCampaignTargetingSchema,
    scheduledAt: z.string().trim().min(1).optional(),
    referencedMenuItemId: z.string().trim().min(1).optional()
  })
  .strict();

export const updateCustomerCampaignDraftSchema = z
  .object({
    campaignId: z.string().trim().min(1),
    name: z.string().trim().min(1).max(120).optional(),
    message: z.string().trim().min(1).max(2000).optional(),
    campaignType: z.enum(customerCampaignTypes).optional(),
    targeting: customerCampaignTargetingSchema.optional(),
    scheduledAt: z.string().trim().min(1).nullable().optional(),
    referencedMenuItemId: z.string().trim().min(1).nullable().optional()
  })
  .strict()
  .refine(
    (value) =>
      Object.entries(value).some(
        ([key, fieldValue]) =>
          key !== "campaignId" && fieldValue !== undefined
      ),
    "At least one editable campaign field is required"
  );

export const campaignIdSchema = z
  .object({
    campaignId: z.string().trim().min(1)
  })
  .strict();

export const approveCampaignSchema = campaignIdSchema
  .extend({
    expectedCampaignVersion: z.number().int().min(1).optional()
  })
  .strict();

export const listCustomerCampaignsSchema = z
  .object({
    status: z.enum(customerCampaignStatuses).optional(),
    campaignType: z.enum(customerCampaignTypes).optional(),
    limit: z.number().int().min(1).max(25).optional()
  })
  .strict();

type CampaignStaffRole = Extract<SenderRole, "owner" | "manager">;

export interface CustomerCampaignAudienceMember {
  customerProfileId: string;
  customerPhone: string;
  qualificationReason: string;
  consentSnapshotUpdatedAt: Date;
}

export interface CustomerCampaignAudiencePreview {
  targetingDescription: string;
  targetedProfiles: number;
  estimatedEligibleRecipients: number;
  excludedNoConsent: number;
  excludedOptOut: number;
  excludedInvalidPhone: number;
  recipients: CustomerCampaignAudienceMember[];
}

export interface CreateCustomerCampaignDraftInput
  extends z.infer<typeof createCustomerCampaignDraftSchema> {
  restaurantId: string;
  createdByPhone: string;
  createdByRole: CampaignStaffRole;
}

export interface UpdateCustomerCampaignDraftInput
  extends z.infer<typeof updateCustomerCampaignDraftSchema> {
  restaurantId: string;
  updatedByPhone: string;
  updatedByRole: CampaignStaffRole;
}

type CampaignProfile = Pick<
  ICustomerProfileDocument,
  | "_id"
  | "customerPhone"
  | "orderCount"
  | "lastOrderAt"
  | "marketingConsent"
  | "isOptedOut"
  | "marketingPreferenceUpdatedAt"
  | "updatedAt"
>;

const ensureObjectId = (value: string, label: string): void => {
  if (!Types.ObjectId.isValid(value)) {
    throw new BadRequestError(`Invalid ${label}`);
  }
};

const isValidMarketingPhone = (phone: string): boolean =>
  /^\+[1-9]\d{7,14}$/.test(phone);

export const resolveCustomerCampaignScheduledAt = (
  scheduledAt: string | Date | undefined,
  timezone: string
): Date | undefined => resolveZonedDateTime(scheduledAt, timezone);

const loadCurrentCampaignStaff = async (
  restaurantId: string,
  senderPhone: string
): Promise<{
  restaurant: IRestaurantDocument;
  phone: string;
  role: CampaignStaffRole;
}> => {
  ensureObjectId(restaurantId, "restaurantId");
  const restaurant = await Restaurant.findOne({
    _id: restaurantId
  }).select(
    "name ownerName ownerPhone managerPhones managerContacts timezone status wasenderSessionId"
  );

  if (!restaurant) {
    throw new NotFoundError("Restaurant not found");
  }

  const sender = resolveSenderIdentity(restaurant, senderPhone);

  if (
    !sender.verified ||
    (sender.role !== "owner" && sender.role !== "manager")
  ) {
    throw new ForbiddenError(
      "Only a verified owner or manager can manage campaigns"
    );
  }

  return {
    restaurant,
    phone: sender.normalizedPhone,
    role: sender.role
  };
};

const normalizeTargetingRule = (
  targeting: z.infer<typeof customerCampaignTargetingSchema>
): CustomerCampaignTargetingRule => ({
  type: targeting.type,
  ...(targeting.inactiveDays
    ? { inactiveDays: targeting.inactiveDays }
    : {}),
  ...(targeting.menuItemId
    ? { menuItemId: new Types.ObjectId(targeting.menuItemId) }
    : {}),
  ...(targeting.startDate
    ? { startDate: new Date(targeting.startDate) }
    : {}),
  ...(targeting.endDate ? { endDate: new Date(targeting.endDate) } : {})
});

const getTargetingMenuItem = async (
  restaurantId: string,
  menuItemId: string
) => {
  ensureObjectId(menuItemId, "menuItemId");
  const item = await MenuItem.findOne({
    _id: menuItemId,
    restaurantId
  }).select("name isAvailable restaurantId");

  if (!item) {
    throw new BadRequestError(
      "The targeting menu item does not belong to this restaurant"
    );
  }

  return item;
};

export const validateCustomerCampaignReferencedItem = async (
  restaurantId: string,
  referencedMenuItemId?: string
): Promise<void> => {
  if (!referencedMenuItemId) {
    return;
  }

  ensureObjectId(referencedMenuItemId, "referencedMenuItemId");
  const item = await MenuItem.findOne({
    _id: referencedMenuItemId,
    restaurantId,
    isAvailable: true
  }).select("_id");

  if (!item) {
    throw new BadRequestError(
      "The referenced menu item is unavailable or does not belong to this restaurant"
    );
  }
};

const getTargetingDescription = (
  targeting: CustomerCampaignTargetingRule,
  menuItemName?: string
): string => {
  switch (targeting.type) {
    case "all_eligible_customers":
      return "All customers";
    case "inactive_customers":
      return `Customers whose last completed order was at least ${targeting.inactiveDays} days ago`;
    case "returning_customers":
      return "Customers with at least two completed orders";
    case "ordered_menu_item":
      return `Customers who completed an order containing ${menuItemName ?? "the selected menu item"}`;
    case "last_order_date_range":
      return `Customers whose last completed order was between ${targeting.startDate?.toISOString()} and ${targeting.endDate?.toISOString()}`;
  }
};

const loadCompletedOrderPhonesForMenuItem = async (
  restaurantId: string,
  menuItemId: string
): Promise<Set<string>> => {
  const orders = await Order.find({
    restaurantId,
    status: "completed",
    "items.menuItemId": menuItemId
  }).select("customerPhone");

  return new Set(
    orders
      .map((order) => normalizeGhanaPhone(order.customerPhone))
      .filter(isValidMarketingPhone)
  );
};

export const selectCustomerCampaignAudience = async (
  restaurantId: string,
  targetingInput:
    | CustomerCampaignTargetingRule
    | z.infer<typeof customerCampaignTargetingSchema>,
  now = new Date()
): Promise<CustomerCampaignAudiencePreview> => {
  ensureObjectId(restaurantId, "restaurantId");
  const targeting =
    typeof targetingInput.startDate === "string" ||
    typeof targetingInput.endDate === "string" ||
    typeof targetingInput.menuItemId === "string"
      ? normalizeTargetingRule(
          customerCampaignTargetingSchema.parse(targetingInput)
        )
      : (targetingInput as CustomerCampaignTargetingRule);
  let menuItemName: string | undefined;
  let orderedMenuItemPhones: Set<string> | undefined;

  if (targeting.type === "ordered_menu_item") {
    const menuItemId = String(targeting.menuItemId);
    const item = await getTargetingMenuItem(restaurantId, menuItemId);
    menuItemName = item.name;
    orderedMenuItemPhones =
      await loadCompletedOrderPhonesForMenuItem(
        restaurantId,
        menuItemId
      );
  }

  const profiles = (await CustomerProfile.find({
    restaurantId
  }).select(
    "customerPhone orderCount lastOrderAt marketingConsent isOptedOut marketingPreferenceUpdatedAt updatedAt"
  )) as CampaignProfile[];
  const recipientsByPhone = new Map<
    string,
    CustomerCampaignAudienceMember
  >();
  let targetedProfiles = 0;
  let excludedNoConsent = 0;
  let excludedOptOut = 0;
  let excludedInvalidPhone = 0;

  for (const profile of profiles) {
    const normalizedPhone = normalizeGhanaPhone(profile.customerPhone);
    let qualificationReason: string | null = null;

    switch (targeting.type) {
      case "all_eligible_customers":
        qualificationReason = "explicit marketing consent";
        break;
      case "inactive_customers": {
        const cutoff = new Date(
          now.getTime() - (targeting.inactiveDays ?? 1) * 86_400_000
        );
        qualificationReason =
          profile.lastOrderAt && profile.lastOrderAt < cutoff
            ? `last completed order before ${cutoff.toISOString()}`
            : null;
        break;
      }
      case "returning_customers":
        qualificationReason =
          profile.orderCount >= 2
            ? "at least two completed orders"
            : null;
        break;
      case "ordered_menu_item":
        qualificationReason = orderedMenuItemPhones?.has(normalizedPhone)
          ? `completed order contained menu item ${String(targeting.menuItemId)}`
          : null;
        break;
      case "last_order_date_range":
        qualificationReason =
          profile.lastOrderAt &&
          targeting.startDate &&
          targeting.endDate &&
          profile.lastOrderAt >= targeting.startDate &&
          profile.lastOrderAt <= targeting.endDate
            ? "last completed order falls within the selected date range"
            : null;
        break;
    }

    if (!qualificationReason) {
      continue;
    }

    targetedProfiles += 1;

    if (!isValidMarketingPhone(normalizedPhone)) {
      excludedInvalidPhone += 1;
      continue;
    }

    if (profile.isOptedOut === true) {
      excludedOptOut += 1;
      continue;
    }

    if (profile.marketingConsent !== true) {
      excludedNoConsent += 1;
      continue;
    }

    if (
      isCustomerEligibleForMarketing(profile) &&
      !recipientsByPhone.has(normalizedPhone)
    ) {
      recipientsByPhone.set(normalizedPhone, {
        customerProfileId: String(profile._id),
        customerPhone: normalizedPhone,
        qualificationReason,
        consentSnapshotUpdatedAt:
          profile.marketingPreferenceUpdatedAt ??
          profile.updatedAt ??
          new Date(0)
      });
    }
  }

  const recipients = Array.from(recipientsByPhone.values());

  return {
    targetingDescription: getTargetingDescription(
      targeting,
      menuItemName
    ),
    targetedProfiles,
    estimatedEligibleRecipients: recipients.length,
    excludedNoConsent,
    excludedOptOut,
    excludedInvalidPhone,
    recipients
  };
};

export const createCustomerCampaignDraft = async (
  input: CreateCustomerCampaignDraftInput,
  now = new Date()
): Promise<{
  campaign: ICustomerCampaignDocument;
  preview: CustomerCampaignAudiencePreview;
}> => {
  const parsed = createCustomerCampaignDraftSchema.parse({
    name: input.name,
    message: input.message,
    campaignType: input.campaignType,
    targeting: input.targeting,
    scheduledAt: input.scheduledAt,
    referencedMenuItemId: input.referencedMenuItemId
  });
  const staff = await loadCurrentCampaignStaff(
    input.restaurantId,
    input.createdByPhone
  );

  if (parsed.targeting.type === "ordered_menu_item") {
    await getTargetingMenuItem(
      input.restaurantId,
      parsed.targeting.menuItemId as string
    );
  }

  await validateCustomerCampaignReferencedItem(
    input.restaurantId,
    parsed.referencedMenuItemId
  );
  const scheduledAt = resolveCustomerCampaignScheduledAt(
    parsed.scheduledAt,
    staff.restaurant.timezone || "Africa/Accra"
  );

  if (scheduledAt && scheduledAt.getTime() <= now.getTime()) {
    throw new BadRequestError("scheduledAt cannot be in the past");
  }

  const targeting = normalizeTargetingRule(parsed.targeting);
  const preview = await selectCustomerCampaignAudience(
    input.restaurantId,
    targeting,
    now
  );
  const campaign = await CustomerCampaign.create({
    restaurantId: input.restaurantId,
    name: parsed.name,
    message: parsed.message,
    campaignType: parsed.campaignType,
    targeting,
    timezone: staff.restaurant.timezone || "Africa/Accra",
    status: "pending_approval",
    campaignVersion: 1,
    referencedMenuItemId: parsed.referencedMenuItemId,
    createdByPhone: staff.phone,
    createdByRole: staff.role,
    scheduledAt,
    estimatedRecipientCount: preview.estimatedEligibleRecipients,
    excludedNoConsentCount: preview.excludedNoConsent,
    excludedOptOutCount: preview.excludedOptOut,
    excludedInvalidPhoneCount: preview.excludedInvalidPhone
  });

  return {
    campaign,
    preview
  };
};

export const updateCustomerCampaignDraft = async (
  input: UpdateCustomerCampaignDraftInput,
  now = new Date()
): Promise<{
  campaign: ICustomerCampaignDocument;
  preview: CustomerCampaignAudiencePreview;
}> => {
  const parsed = updateCustomerCampaignDraftSchema.parse({
    campaignId: input.campaignId,
    name: input.name,
    message: input.message,
    campaignType: input.campaignType,
    targeting: input.targeting,
    scheduledAt: input.scheduledAt,
    referencedMenuItemId: input.referencedMenuItemId
  });
  const staff = await loadCurrentCampaignStaff(
    input.restaurantId,
    input.updatedByPhone
  );
  const campaign = await getCustomerCampaignForRestaurant(
    input.restaurantId,
    parsed.campaignId
  );

  if (campaign.status !== "pending_approval") {
    throw new BadRequestError(
      "Only campaigns awaiting approval can be edited",
      "CAMPAIGN_NOT_EDITABLE"
    );
  }
  const previousCampaignVersion = campaign.campaignVersion;

  if (parsed.targeting?.type === "ordered_menu_item") {
    await getTargetingMenuItem(
      input.restaurantId,
      parsed.targeting.menuItemId as string
    );
  }

  if (parsed.referencedMenuItemId !== undefined) {
    await validateCustomerCampaignReferencedItem(
      input.restaurantId,
      parsed.referencedMenuItemId ?? undefined
    );
  }

  const targeting = parsed.targeting
    ? normalizeTargetingRule(parsed.targeting)
    : campaign.targeting;
  const scheduledAt =
    parsed.scheduledAt === undefined
      ? campaign.scheduledAt
      : parsed.scheduledAt === null
        ? undefined
        : resolveCustomerCampaignScheduledAt(
            parsed.scheduledAt,
            staff.restaurant.timezone || campaign.timezone
          );

  if (scheduledAt && scheduledAt.getTime() <= now.getTime()) {
    throw new BadRequestError("scheduledAt cannot be in the past");
  }

  const preview = await selectCustomerCampaignAudience(
    input.restaurantId,
    targeting,
    now
  );

  if (parsed.name !== undefined) campaign.name = parsed.name;
  if (parsed.message !== undefined) campaign.message = parsed.message;
  if (parsed.campaignType !== undefined) {
    campaign.campaignType = parsed.campaignType;
  }
  if (parsed.targeting !== undefined) campaign.targeting = targeting;
  if (parsed.scheduledAt !== undefined) campaign.scheduledAt = scheduledAt;
  if (parsed.referencedMenuItemId !== undefined) {
    campaign.referencedMenuItemId = parsed.referencedMenuItemId
      ? new Types.ObjectId(parsed.referencedMenuItemId)
      : undefined;
  }
  campaign.timezone = staff.restaurant.timezone || campaign.timezone;
  campaign.estimatedRecipientCount = preview.estimatedEligibleRecipients;
  campaign.excludedNoConsentCount = preview.excludedNoConsent;
  campaign.excludedOptOutCount = preview.excludedOptOut;
  campaign.excludedInvalidPhoneCount = preview.excludedInvalidPhone;
  campaign.$where = {
    status: "pending_approval",
    campaignVersion: previousCampaignVersion
  };
  await campaign.save();

  await PendingAgentAction.updateMany(
    {
      restaurantId: input.restaurantId,
      action: "TOOL_CALL",
      toolName: "approve_campaign",
      status: "pending",
      "arguments.campaignId": String(campaign._id),
      "arguments.expectedCampaignVersion": {
        $ne: campaign.campaignVersion
      }
    },
    {
      $set: {
        status: "cancelled",
        resultMessage:
          "Campaign approval superseded by a newer campaign preview."
      }
    }
  );

  return { campaign, preview };
};

export const getCustomerCampaignForRestaurant = async (
  restaurantId: string,
  campaignId: string
): Promise<ICustomerCampaignDocument> => {
  ensureObjectId(restaurantId, "restaurantId");
  ensureObjectId(campaignId, "campaignId");
  const campaign = await CustomerCampaign.findOne({
    _id: campaignId,
    restaurantId
  });

  if (!campaign) {
    throw new NotFoundError("Campaign not found");
  }

  return campaign;
};

export const previewCustomerCampaign = async (
  restaurantId: string,
  campaignId: string,
  now = new Date()
): Promise<{
  campaign: ICustomerCampaignDocument;
  preview: CustomerCampaignAudiencePreview;
}> => {
  const campaign = await getCustomerCampaignForRestaurant(
    restaurantId,
    campaignId
  );
  const preview = await selectCustomerCampaignAudience(
    restaurantId,
    campaign.targeting,
    now
  );

  return {
    campaign,
    preview
  };
};

export const buildCustomerCampaignPreviewMessage = (
  campaign: Pick<
    ICustomerCampaignDocument,
    "name" | "message" | "scheduledAt" | "timezone"
  >,
  preview: CustomerCampaignAudiencePreview
): string => {
  const audienceLines = [
    `Campaign Preview: ${campaign.name}`,
    "",
    campaign.message,
    "",
    `Audience: ${preview.targetingDescription}`,
    "",
    `Customers in audience: ${preview.targetedProfiles}`,
    `Can receive promotions: ${preview.estimatedEligibleRecipients}`,
    `Not opted in yet: ${preview.excludedNoConsent}`,
    `Opted out: ${preview.excludedOptOut}`
  ];

  if (preview.excludedInvalidPhone > 0) {
    audienceLines.push(
      `Invalid/unreachable phone numbers: ${preview.excludedInvalidPhone}`
    );
  }

  audienceLines.push(
    "",
    `This campaign will be sent to ${preview.estimatedEligibleRecipients} customers.`,
    "",
    "Would you like to confirm or cancel it?"
  );

  return audienceLines.join("\n");
};

export const approveCustomerCampaign = async (
  restaurantId: string,
  campaignId: string,
  approverPhone: string,
  now = new Date(),
  options: {
    expectedCampaignVersion: number;
    startSession?: () => Promise<ClientSession>;
  }
): Promise<ICustomerCampaignDocument> => {
  const campaign = await getCustomerCampaignForRestaurant(
    restaurantId,
    campaignId
  );

  if (campaign.status !== "pending_approval") {
    throw new BadRequestError(
      "Campaign is no longer awaiting approval"
    );
  }

  const expectedCampaignVersion = options.expectedCampaignVersion;

  if (
    !Number.isInteger(expectedCampaignVersion) ||
    expectedCampaignVersion < 1
  ) {
    throw new BadRequestError(
      "Campaign approval requires the exact preview version",
      "CAMPAIGN_VERSION_REQUIRED"
    );
  }

  if (campaign.campaignVersion !== expectedCampaignVersion) {
    throw new BadRequestError(
      "Campaign approval was superseded by another update"
    );
  }

  const staff = await loadCurrentCampaignStaff(
    restaurantId,
    approverPhone
  );
  await validateCustomerCampaignReferencedItem(
    restaurantId,
    campaign.referencedMenuItemId
      ? String(campaign.referencedMenuItemId)
      : undefined
  );
  const preview = await selectCustomerCampaignAudience(
    restaurantId,
    campaign.targeting,
    now
  );
  const restaurantObjectId = new Types.ObjectId(restaurantId);
  const session = await (
    options.startSession ?? (() => CustomerCampaign.db.startSession())
  )();
  let approvedCampaign: ICustomerCampaignDocument | null = null;

  try {
    await session.withTransaction(async () => {
      const claimedCampaign =
        await CustomerCampaign.findOneAndUpdate(
          {
            _id: campaignId,
            restaurantId,
            status: "pending_approval",
            campaignVersion: expectedCampaignVersion
          },
          {
            $set: {
              status: "snapshotting"
            }
          },
          {
            new: true,
            runValidators: true,
            session
          }
        );

      if (!claimedCampaign) {
        throw new BadRequestError(
          "Campaign approval was superseded by another update"
        );
      }

      await CustomerCampaignRecipient.updateMany(
        {
          restaurantId,
          campaignId: claimedCampaign._id,
          campaignVersion: {
            $ne: expectedCampaignVersion
          },
          status: {
            $ne: "sent"
          }
        },
        {
          $set: {
            status: "cancelled",
            attemptedAt: now,
            failureReason:
              "Recipient snapshot superseded by a newer campaign version"
          }
        },
        {
          session
        }
      );

      await CustomerCampaignRecipient.deleteMany(
        {
          restaurantId,
          campaignId: claimedCampaign._id,
          campaignVersion: expectedCampaignVersion,
          status: {
            $ne: "sent"
          }
        },
        {
          session
        }
      );

      if (preview.recipients.length > 0) {
        await CustomerCampaignRecipient.insertMany(
          preview.recipients.map((recipient) => ({
            restaurantId: restaurantObjectId,
            campaignId: claimedCampaign._id,
            customerProfileId: new Types.ObjectId(
              recipient.customerProfileId
            ),
            customerPhone: recipient.customerPhone,
            campaignVersion: expectedCampaignVersion,
            qualificationReason: recipient.qualificationReason,
            consentSnapshotUpdatedAt:
              recipient.consentSnapshotUpdatedAt,
            status: "pending"
          })),
          {
            ordered: true,
            session
          }
        );
      }

      const totalRecipientCount =
        await CustomerCampaignRecipient.countDocuments(
          {
            restaurantId,
            campaignId: claimedCampaign._id,
            campaignVersion: expectedCampaignVersion
          },
          {
            session
          }
        );
      const nextStatus =
        claimedCampaign.scheduledAt &&
        claimedCampaign.scheduledAt > now
          ? "scheduled"
          : "approved";
      const approved = await CustomerCampaign.findOneAndUpdate(
        {
          _id: campaignId,
          restaurantId,
          status: "snapshotting",
          campaignVersion: expectedCampaignVersion
        },
        {
          $set: {
            status: nextStatus,
            approvedByPhone: staff.phone,
            approvedByRole: staff.role,
            approvedAt: now,
            estimatedRecipientCount:
              preview.estimatedEligibleRecipients,
            totalRecipientCount,
            excludedNoConsentCount: preview.excludedNoConsent,
            excludedOptOutCount: preview.excludedOptOut,
            excludedInvalidPhoneCount:
              preview.excludedInvalidPhone
          }
        },
        {
          new: true,
          runValidators: true,
          session
        }
      );

      if (!approved) {
        throw new BadRequestError(
          "Campaign approval was superseded by another update"
        );
      }

      approvedCampaign = approved;
    });
  } finally {
    await session.endSession();
  }

  if (!approvedCampaign) {
    throw new BadRequestError("Campaign approval did not complete");
  }

  return approvedCampaign;
};

export const cancelCustomerCampaign = async (
  restaurantId: string,
  campaignId: string,
  cancelledByPhone: string,
  now = new Date()
): Promise<ICustomerCampaignDocument> => {
  const campaign = await getCustomerCampaignForRestaurant(
    restaurantId,
    campaignId
  );
  await loadCurrentCampaignStaff(restaurantId, cancelledByPhone);

  if (["sent", "failed", "cancelled"].includes(campaign.status)) {
    if (campaign.status === "cancelled") {
      return campaign;
    }

    throw new BadRequestError("Campaign can no longer be cancelled");
  }

  const cancelled = await CustomerCampaign.findOneAndUpdate(
    {
      _id: campaignId,
      restaurantId,
      status: {
        $nin: ["sent", "failed", "cancelled"]
      }
    },
    {
      $set: {
        status: "cancelled",
        cancelledAt: now
      }
    },
    {
      new: true
    }
  );

  if (!cancelled) {
    throw new BadRequestError("Campaign can no longer be cancelled");
  }

  const reason = "Campaign cancelled before delivery";
  await Promise.all([
    CustomerCampaignRecipient.updateMany(
      {
        restaurantId,
        campaignId,
        status: "pending"
      },
      {
        $set: {
          status: "cancelled",
          attemptedAt: now,
          failureReason: reason
        }
      }
    ),
    OutboundMessage.updateMany(
      {
        restaurantId,
        status: "pending",
        "metadata.kind": "customer_campaign",
        "metadata.campaignId": campaignId
      },
      {
        $set: {
          status: "cancelled",
          lastError: reason
        }
      }
    )
  ]);

  return cancelled;
};

export const listCustomerCampaigns = async (
  restaurantId: string,
  input: z.infer<typeof listCustomerCampaignsSchema> = {}
): Promise<ICustomerCampaignDocument[]> => {
  ensureObjectId(restaurantId, "restaurantId");
  const parsed = listCustomerCampaignsSchema.parse(input);

  return CustomerCampaign.find({
    restaurantId,
    ...(parsed.status ? { status: parsed.status } : {}),
    ...(parsed.campaignType
      ? { campaignType: parsed.campaignType }
      : {})
  })
    .sort({ createdAt: -1 })
    .limit(parsed.limit ?? 10);
};

export const formatCustomerCampaignMessage = (
  restaurantName: string,
  approvedMessage: string
): string => {
  const message = approvedMessage.trim();
  const alreadyHasStopInstruction =
    /\b(?:reply|text|send)\s+stop\b/i.test(message) ||
    /\bopt[\s-]?out\b/i.test(message) ||
    /\bstop\s+(?:receiving|getting)\s+(?:promotions|promotional\s+messages|offers)\b/i.test(
      message
    );
  const lines = [restaurantName, "", message];

  if (!alreadyHasStopInstruction) {
    lines.push(
      "",
      `Reply STOP to stop receiving promotions from ${restaurantName}.`
    );
  }

  return lines.join("\n");
};

export interface CustomerCampaignAggregate {
  total: number;
  pending: number;
  sent: number;
  failed: number;
  cancelled: number;
  queued: number;
  status:
    | "sending"
    | "sent"
    | "partially_failed"
    | "failed";
}

export const updateCustomerCampaignAggregate = async (
  restaurantId: string,
  campaignId: string,
  campaignVersionOrNow?: number | Date,
  aggregateNow?: Date
): Promise<CustomerCampaignAggregate | null> => {
  const requestedCampaignVersion =
    typeof campaignVersionOrNow === "number"
      ? campaignVersionOrNow
      : undefined;
  const now =
    campaignVersionOrNow instanceof Date
      ? campaignVersionOrNow
      : (aggregateNow ?? new Date());
  const campaign = await CustomerCampaign.findOne({
    _id: campaignId,
    restaurantId
  }).select("status campaignVersion");

  if (!campaign || campaign.status === "cancelled") {
    return null;
  }

  const campaignVersion =
    requestedCampaignVersion ?? campaign.campaignVersion;

  if (campaign.campaignVersion !== campaignVersion) {
    return null;
  }

  const recipients = await CustomerCampaignRecipient.find({
    restaurantId,
    campaignId,
    campaignVersion
  }).select("status outboundMessageId");
  const counts: Record<CustomerCampaignRecipientStatus, number> = {
    pending: 0,
    sent: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0
  };
  let queued = 0;

  for (const recipient of recipients) {
    counts[recipient.status] += 1;

    if (recipient.outboundMessageId) {
      queued += 1;
    }
  }

  const status =
    counts.pending > 0
      ? "sending"
      : counts.sent === recipients.length
        ? "sent"
        : counts.sent > 0
          ? "partially_failed"
          : "failed";
  const aggregate: CustomerCampaignAggregate = {
    total: recipients.length,
    pending: counts.pending,
    sent: counts.sent,
    failed: counts.failed,
    cancelled: counts.cancelled + counts.skipped,
    queued,
    status
  };

  await CustomerCampaign.updateOne(
    {
      _id: campaignId,
      restaurantId,
      campaignVersion,
      status: { $ne: "cancelled" }
    },
    {
      $set: {
        status,
        totalRecipientCount: aggregate.total,
        queuedRecipientCount: aggregate.queued,
        sentRecipientCount: aggregate.sent,
        failedRecipientCount: aggregate.failed,
        cancelledRecipientCount: aggregate.cancelled,
        ...(counts.pending === 0 ? { completedAt: now } : {})
      },
      ...(counts.pending > 0
        ? {
            $unset: {
              completedAt: ""
            }
          }
        : {})
    }
  );

  return aggregate;
};

export const createCampaignDraft = createCustomerCampaignDraft;
export const updateCampaignDraft = updateCustomerCampaignDraft;
export const previewCampaign = previewCustomerCampaign;
export const approveCampaign = approveCustomerCampaign;
export const cancelCampaign = cancelCustomerCampaign;
export const listCampaigns = listCustomerCampaigns;
