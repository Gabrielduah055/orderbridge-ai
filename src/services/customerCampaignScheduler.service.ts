import {
  CustomerCampaign,
  type ICustomerCampaignDocument
} from "../models/customerCampaign.model";
import {
  CustomerCampaignRecipient,
  type ICustomerCampaignRecipientDocument
} from "../models/customerCampaignRecipient.model";
import { OutboundMessage } from "../models/outboundMessage.model";
import {
  Restaurant,
  type IRestaurantDocument
} from "../models/Restaurant";
import {
  formatCustomerCampaignMessage,
  updateCustomerCampaignAggregate,
  validateCustomerCampaignReferencedItem
} from "./customerCampaign.service";
import {
  enqueueWasenderMessage,
  type EnqueueWasenderMessageInput
} from "./wasenderQueue.service";

const CAMPAIGN_CHECK_INTERVAL_MS = 60_000;
export const CUSTOMER_CAMPAIGN_BATCH_SIZE = 100;
export const CUSTOMER_CAMPAIGN_MAX_MESSAGES_PER_PASS = 500;
let schedulerStarted = false;
let schedulerBusy = false;

type CampaignDeliveryRestaurant = Pick<
  IRestaurantDocument,
  | "_id"
  | "name"
  | "status"
  | "wasenderSessionId"
  | "wasenderApiToken"
>;

export interface CustomerCampaignSchedulerDependencies {
  loadRestaurants?: () => Promise<CampaignDeliveryRestaurant[]>;
  loadCampaigns?: (
    restaurantId: string,
    now: Date
  ) => Promise<ICustomerCampaignDocument[]>;
  loadRecipients?: (
    restaurantId: string,
    campaignId: string,
    campaignVersion: number,
    batchSize: number
  ) => Promise<ICustomerCampaignRecipientDocument[]>;
  messageExists?: (
    restaurantId: string,
    idempotencyKey: string
  ) => Promise<boolean | { _id?: unknown } | null>;
  enqueueMessage?: (
    input: EnqueueWasenderMessageInput
  ) => Promise<{ _id?: unknown }>;
  attachOutboundMessage?: (
    restaurantId: string,
    recipientId: string,
    campaignVersion: number,
    outboundMessageId: unknown
  ) => Promise<void>;
  markCampaignSending?: (
    restaurantId: string,
    campaignId: string,
    campaignVersion: number,
    now: Date
  ) => Promise<void>;
  validateReferencedItem?: (
    restaurantId: string,
    referencedMenuItemId?: string
  ) => Promise<void>;
  cancelInvalidCampaign?: (
    restaurantId: string,
    campaignId: string,
    reason: string,
    now: Date
  ) => Promise<void>;
  updateAggregate?: typeof updateCustomerCampaignAggregate;
  batchSize?: number;
  maxMessagesPerPass?: number;
  logError?: (
    message: string,
    context: Record<string, unknown>
  ) => void;
}

export interface CustomerCampaignSchedulerPassResult {
  campaignsChecked: number;
  recipientsChecked: number;
  messagesQueued: number;
  errors: number;
}

const loadDueCampaigns = async (
  restaurantId: string,
  now: Date
): Promise<ICustomerCampaignDocument[]> => {
  return CustomerCampaign.find({
    restaurantId,
    status: {
      $in: ["approved", "scheduled", "sending"]
    },
    approvedAt: { $exists: true },
    $or: [
      {
        scheduledAt: { $exists: false }
      },
      {
        scheduledAt: { $lte: now }
      }
    ]
  })
    .sort({ scheduledAt: 1, approvedAt: 1 })
    .limit(50);
};

const loadActiveRestaurants = async (): Promise<
  CampaignDeliveryRestaurant[]
> => {
  return Restaurant.find({
    status: {
      $in: ["trial", "active"]
    },
    wasenderSessionId: {
      $exists: true,
      $ne: ""
    },
    wasenderApiToken: {
      $exists: true,
      $ne: ""
    }
  }).select("+wasenderApiToken");
};

const loadPendingRecipients = async (
  restaurantId: string,
  campaignId: string,
  campaignVersion: number,
  batchSize: number
): Promise<ICustomerCampaignRecipientDocument[]> => {
  return CustomerCampaignRecipient.find({
    restaurantId,
    campaignId,
    campaignVersion,
    status: "pending",
    outboundMessageId: { $exists: false }
  })
    .sort({ createdAt: 1 })
    .limit(batchSize);
};

const defaultMessageExists = async (
  restaurantId: string,
  idempotencyKey: string
): Promise<{ _id?: unknown } | null> => {
  return OutboundMessage.findOne({
    restaurantId,
    idempotencyKey
  }).select("_id");
};

const attachOutboundMessage = async (
  restaurantId: string,
  recipientId: string,
  campaignVersion: number,
  outboundMessageId: unknown
): Promise<void> => {
  if (!outboundMessageId) {
    return;
  }

  await CustomerCampaignRecipient.updateOne(
    {
      _id: recipientId,
      restaurantId,
      campaignVersion,
      status: "pending"
    },
    {
      $set: {
        outboundMessageId
      }
    }
  );
};

const markCampaignSending = async (
  restaurantId: string,
  campaignId: string,
  campaignVersion: number,
  now: Date
): Promise<void> => {
  await CustomerCampaign.updateOne(
    {
      _id: campaignId,
      restaurantId,
      campaignVersion,
      status: {
        $in: ["approved", "scheduled", "sending"]
      }
    },
    {
      $set: {
        status: "sending",
        sendingStartedAt: now
      }
    }
  );
};

const cancelInvalidCampaign = async (
  restaurantId: string,
  campaignId: string,
  reason: string,
  now: Date
): Promise<void> => {
  await Promise.all([
    CustomerCampaign.updateOne(
      {
        _id: campaignId,
        restaurantId,
        status: {
          $in: ["approved", "scheduled", "sending"]
        }
      },
      {
        $set: {
          status: "cancelled",
          cancelledAt: now,
          failureReason: reason
        }
      }
    ),
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
};

export const getCustomerCampaignIdempotencyKey = (
  campaignId: string,
  recipientId: string,
  campaignVersion: number
): string =>
  `customer-campaign:${campaignId}:${recipientId}:${campaignVersion}`;

export const runCustomerCampaignSchedulerPass = async (
  now = new Date(),
  dependencies: CustomerCampaignSchedulerDependencies = {}
): Promise<CustomerCampaignSchedulerPassResult> => {
  const loadRestaurants =
    dependencies.loadRestaurants ?? loadActiveRestaurants;
  const loadCampaigns = dependencies.loadCampaigns ?? loadDueCampaigns;
  const loadRecipients =
    dependencies.loadRecipients ?? loadPendingRecipients;
  const messageExists =
    dependencies.messageExists ?? defaultMessageExists;
  const enqueueMessage =
    dependencies.enqueueMessage ?? enqueueWasenderMessage;
  const attachMessage =
    dependencies.attachOutboundMessage ?? attachOutboundMessage;
  const setCampaignSending =
    dependencies.markCampaignSending ?? markCampaignSending;
  const validateReferencedItem =
    dependencies.validateReferencedItem ??
    validateCustomerCampaignReferencedItem;
  const cancelCampaign =
    dependencies.cancelInvalidCampaign ?? cancelInvalidCampaign;
  const updateAggregate =
    dependencies.updateAggregate ?? updateCustomerCampaignAggregate;
  const batchSize = Math.max(
    1,
    Math.min(
      dependencies.batchSize ?? CUSTOMER_CAMPAIGN_BATCH_SIZE,
      CUSTOMER_CAMPAIGN_BATCH_SIZE
    )
  );
  const maxMessagesPerPass = Math.max(
    1,
    Math.min(
      dependencies.maxMessagesPerPass ??
        CUSTOMER_CAMPAIGN_MAX_MESSAGES_PER_PASS,
      CUSTOMER_CAMPAIGN_MAX_MESSAGES_PER_PASS
    )
  );
  const logError =
    dependencies.logError ??
    ((message: string, context: Record<string, unknown>) =>
      console.error(message, context));
  const restaurants = await loadRestaurants();
  const result: CustomerCampaignSchedulerPassResult = {
    campaignsChecked: 0,
    recipientsChecked: 0,
    messagesQueued: 0,
    errors: 0
  };

  for (const restaurant of restaurants) {
    const restaurantId = String(restaurant._id);
    let campaigns: ICustomerCampaignDocument[];

    try {
      campaigns = await loadCampaigns(restaurantId, now);
    } catch (error) {
      result.errors += 1;
      logError("Customer campaign lookup failed", {
        restaurantId,
        error:
          error instanceof Error
            ? error.message
            : "Unknown customer campaign lookup error"
      });
      continue;
    }

    result.campaignsChecked += campaigns.length;

    for (const campaign of campaigns) {
      const campaignId = String(campaign._id);

      if (String(campaign.restaurantId) !== restaurantId) {
        result.errors += 1;
        logError("Cross-restaurant campaign result rejected", {
          restaurantId,
          campaignId,
          campaignRestaurantId: String(campaign.restaurantId)
        });
        continue;
      }

    try {
      if (
        !["approved", "scheduled", "sending"].includes(
          campaign.status
        )
      ) {
        continue;
      }

      if (campaign.scheduledAt && campaign.scheduledAt > now) {
        continue;
      }

      try {
        await validateReferencedItem(
          restaurantId,
          campaign.referencedMenuItemId
            ? String(campaign.referencedMenuItemId)
            : undefined
        );
      } catch (error) {
        const reason =
          error instanceof Error
            ? error.message
            : "Campaign referenced menu item is unavailable";
        await cancelCampaign(
          restaurantId,
          campaignId,
          reason,
          now
        );
        continue;
      }

      const recipients = (
        await loadRecipients(
          restaurantId,
          campaignId,
          campaign.campaignVersion,
          batchSize
        )
      ).slice(0, batchSize);

      for (const recipient of recipients) {
        if (result.messagesQueued >= maxMessagesPerPass) {
          await updateAggregate(
            restaurantId,
            campaignId,
            campaign.campaignVersion,
            now
          );
          return result;
        }

        result.recipientsChecked += 1;
        const recipientId = String(recipient._id);
        const idempotencyKey = getCustomerCampaignIdempotencyKey(
          campaignId,
          recipientId,
          campaign.campaignVersion
        );

        try {
          const existingMessage = await messageExists(
            restaurantId,
            idempotencyKey
          );

          if (existingMessage) {
            if (
              typeof existingMessage === "object" &&
              existingMessage._id
            ) {
              await attachMessage(
                restaurantId,
                recipientId,
                campaign.campaignVersion,
                existingMessage._id
              );
            }

            continue;
          }

          const queued = await enqueueMessage({
            restaurantId,
            sessionId: restaurant.wasenderSessionId,
            to: recipient.customerPhone,
            type: "text",
            text: formatCustomerCampaignMessage(
              restaurant.name,
              campaign.message
            ),
            apiKey: restaurant.wasenderApiToken,
            idempotencyKey,
            metadata: {
              kind: "customer_campaign",
              restaurantId,
              campaignId,
              campaignRecipientId: recipientId,
              campaignVersion: campaign.campaignVersion,
              customerPhone: recipient.customerPhone,
              consentSnapshotUpdatedAt:
                recipient.consentSnapshotUpdatedAt.toISOString(),
              recipientType: "customer",
              purpose: "marketing"
            }
          });

          await attachMessage(
            restaurantId,
            recipientId,
            campaign.campaignVersion,
            queued._id
          );
          await setCampaignSending(
            restaurantId,
            campaignId,
            campaign.campaignVersion,
            now
          );
          result.messagesQueued += 1;
        } catch (error) {
          result.errors += 1;
          logError("Customer campaign recipient queueing failed", {
            restaurantId,
            campaignId,
            campaignRecipientId: recipientId,
            error:
              error instanceof Error
                ? error.message
                : "Unknown campaign recipient queueing error"
          });
        }
      }

      await updateAggregate(
        restaurantId,
        campaignId,
        campaign.campaignVersion,
        now
      );
    } catch (error) {
      result.errors += 1;
      logError("Customer campaign processing failed", {
        restaurantId,
        campaignId,
        error:
          error instanceof Error
            ? error.message
            : "Unknown customer campaign processing error"
      });
    }
    }
  }

  return result;
};

export const startCustomerCampaignScheduler = (): void => {
  if (schedulerStarted) {
    return;
  }

  schedulerStarted = true;
  console.log(
    `[customerCampaign] Scheduler started (check every ${CAMPAIGN_CHECK_INTERVAL_MS / 1000}s)`
  );

  const runPass = (): void => {
    if (schedulerBusy) {
      return;
    }

    schedulerBusy = true;
    void runCustomerCampaignSchedulerPass()
      .catch((error) => {
        console.error("Customer campaign scheduler pass failed", {
          error:
            error instanceof Error
              ? error.message
              : "Unknown customer campaign scheduler error"
        });
      })
      .finally(() => {
        schedulerBusy = false;
      });
  };

  runPass();
  const timer = setInterval(runPass, CAMPAIGN_CHECK_INTERVAL_MS);
  timer.unref?.();
};
