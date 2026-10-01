import { PendingAgentAction } from "../models/pendingAgentAction.model";
import type { SenderRole, ToolResult } from "../types/agent.types";
import {
  deleteImageByUrl,
  validateTrustedCloudinaryImage,
  type TrustedCloudinaryImage
} from "./cloudinary.service";
import {
  buildCustomerCampaignPreviewMessage,
  getCustomerCampaignForRestaurant,
  previewCustomerCampaign
} from "./customerCampaign.service";

const campaignImageContextTtlMs = 10 * 60_000;

interface CampaignImageWorkflowInput {
  restaurantId: string;
  senderPhone: string;
  senderRole: SenderRole;
}

export const startCampaignImageUpload = async (
  input: CampaignImageWorkflowInput & { campaignId: string }
): Promise<ToolResult> => {
  if (input.senderRole !== "owner") {
    return {
      success: false,
      code: "CAMPAIGN_IMAGE_FORBIDDEN",
      message: "Campaign image uploads are available only to the verified owner."
    };
  }
  const campaign = await getCustomerCampaignForRestaurant(
    input.restaurantId,
    input.campaignId
  );
  if (campaign.status !== "pending_approval") {
    return {
      success: false,
      code: "CAMPAIGN_NOT_EDITABLE",
      message: "Only a campaign awaiting approval can receive a new image."
    };
  }

  await PendingAgentAction.updateMany(
    {
      restaurantId: input.restaurantId,
      senderPhone: input.senderPhone,
      senderRole: "owner",
      action: "CAMPAIGN_IMAGE_CONTEXT",
      status: "pending"
    },
    {
      $set: {
        status: "cancelled",
        resultMessage: "Superseded by a newer campaign image request."
      }
    }
  );
  const action = await PendingAgentAction.create({
    restaurantId: input.restaurantId,
    senderPhone: input.senderPhone,
    senderRole: "owner",
    action: "CAMPAIGN_IMAGE_CONTEXT",
    data: {
      stage: "awaiting_image",
      campaignId: String(campaign._id),
      expectedCampaignVersion: campaign.campaignVersion
    },
    status: "pending",
    summary: `Waiting for an image for campaign ${campaign.name}`,
    confirmationMessage:
      "Send the JPG, PNG, or WEBP image now. It must be 5 MB or smaller. I will attach the trusted upload to this campaign and show a new preview for approval.",
    expiresAt: new Date(Date.now() + campaignImageContextTtlMs)
  });

  return {
    success: true,
    message: action.confirmationMessage,
    pendingActionId: String(action._id),
    data: {
      campaignId: String(campaign._id),
      campaignVersion: campaign.campaignVersion,
      stage: "awaiting_image"
    }
  };
};

export const hasPendingCampaignImageUpload = async (
  input: CampaignImageWorkflowInput
): Promise<boolean> => Boolean(await PendingAgentAction.exists({
  restaurantId: input.restaurantId,
  senderPhone: input.senderPhone,
  senderRole: "owner",
  action: "CAMPAIGN_IMAGE_CONTEXT",
  status: "pending",
  expiresAt: { $gt: new Date() },
  "data.stage": "awaiting_image"
}));

export const prepareUploadedCampaignImage = async (
  input: CampaignImageWorkflowInput & { image: TrustedCloudinaryImage }
): Promise<{ handled: boolean; success: boolean; message: string }> => {
  if (input.senderRole !== "owner") {
    return { handled: false, success: false, message: "" };
  }
  const action = await PendingAgentAction.findOne({
    restaurantId: input.restaurantId,
    senderPhone: input.senderPhone,
    senderRole: "owner",
    action: "CAMPAIGN_IMAGE_CONTEXT",
    status: "pending",
    expiresAt: { $gt: new Date() },
    "data.stage": "awaiting_image"
  }).sort({ createdAt: -1 });
  if (!action) return { handled: false, success: false, message: "" };
  if (!validateTrustedCloudinaryImage(input.image)) {
    return {
      handled: true,
      success: false,
      message: "The uploaded image failed trusted validation. Please send it again."
    };
  }

  const campaignId = String(action.data?.campaignId ?? "");
  const expectedCampaignVersion = Number(action.data?.expectedCampaignVersion);
  const campaign = await getCustomerCampaignForRestaurant(
    input.restaurantId,
    campaignId
  );
  if (
    campaign.status !== "pending_approval" ||
    campaign.campaignVersion !== expectedCampaignVersion
  ) {
    action.status = "cancelled";
    action.resultMessage = "The campaign changed before the image arrived.";
    await action.save();
    await deleteImageByUrl(input.image.secureUrl);
    return {
      handled: true,
      success: false,
      message:
        "That campaign changed before the image arrived. Open its latest preview and start the image upload again."
    };
  }

  const previousUploadUrl =
    campaign.attachmentType === "upload" ? campaign.imageUrl : undefined;
  campaign.attachmentType = "upload";
  campaign.imageUrl = input.image.secureUrl;
  campaign.imagePublicId = input.image.publicId;
  campaign.imageMenuItemId = undefined;
  campaign.imageLabel = "Owner-uploaded campaign image";
  campaign.$where = {
    status: "pending_approval",
    campaignVersion: expectedCampaignVersion
  };
  await campaign.save();

  await PendingAgentAction.updateMany(
    {
      restaurantId: input.restaurantId,
      action: "TOOL_CALL",
      toolName: "approve_campaign",
      status: "pending",
      "arguments.campaignId": campaignId
    },
    {
      $set: {
        status: "cancelled",
        resultMessage: "Campaign approval superseded by the uploaded image."
      }
    }
  );
  const { preview } = await previewCustomerCampaign(
    input.restaurantId,
    campaignId
  );
  const previewMessage = buildCustomerCampaignPreviewMessage(campaign, preview);
  await PendingAgentAction.create({
    restaurantId: input.restaurantId,
    senderPhone: input.senderPhone,
    senderRole: "owner",
    action: "TOOL_CALL",
    toolName: "approve_campaign",
    arguments: {
      campaignId,
      expectedCampaignVersion: campaign.campaignVersion
    },
    data: {
      campaignId,
      expectedCampaignVersion: campaign.campaignVersion
    },
    status: "pending",
    summary: "Approve campaign with uploaded image",
    confirmationMessage: previewMessage,
    expiresAt: new Date(Date.now() + 15 * 60_000)
  });

  action.status = "completed";
  action.completedAt = new Date();
  action.imageSecureUrl = input.image.secureUrl;
  action.imagePublicId = input.image.publicId;
  action.uploadedAt = input.image.uploadedAt;
  action.resultMessage = "Campaign image attached and a new approval preview created.";
  await action.save();

  if (previousUploadUrl && previousUploadUrl !== input.image.secureUrl) {
    await deleteImageByUrl(previousUploadUrl);
  }

  return {
    handled: true,
    success: true,
    message: previewMessage
  };
};
