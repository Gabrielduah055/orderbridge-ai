import { Types } from "mongoose";
import { z } from "zod";
import {
  OutboundMessage,
  outboundMessageStatuses,
  type IOutboundMessageDocument,
  type OutboundMessageStatus
} from "../models/outboundMessage.model";
import { Restaurant, type IRestaurantDocument } from "../models/Restaurant";
import type { SenderRole } from "../types/agent.types";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError
} from "../utils/httpErrors";
import { resolveZonedDateTime } from "../utils/zonedDateTime.util";
import { resolveSenderIdentity } from "./senderIdentity.service";
import { enqueueWasenderMessage } from "./wasenderQueue.service";

const reminderIdSchema = z.string().trim().refine(
  (value) => Types.ObjectId.isValid(value),
  "A valid reminderId is required"
);

export const createStaffReminderSchema = z
  .object({
    text: z.string().trim().min(1).max(500),
    scheduledAt: z.string().trim().min(1)
  })
  .strict();

export const listStaffRemindersSchema = z
  .object({
    status: z.enum(outboundMessageStatuses).optional(),
    limit: z.number().int().min(1).max(25).optional()
  })
  .strict();

export const rescheduleStaffReminderSchema = z
  .object({
    reminderId: reminderIdSchema,
    scheduledAt: z.string().trim().min(1)
  })
  .strict();

export const cancelStaffReminderSchema = z
  .object({
    reminderId: reminderIdSchema
  })
  .strict();

type StaffReminderRole = Extract<SenderRole, "owner" | "manager">;

interface CurrentReminderStaff {
  restaurant: IRestaurantDocument;
  phone: string;
  role: StaffReminderRole;
}

export interface StaffReminderView {
  reminderId: string;
  text: string;
  scheduledFor: Date;
  status: OutboundMessageStatus;
  createdAt: Date;
  sentAt?: Date;
}

const loadCurrentReminderStaff = async (
  restaurantId: string,
  senderPhone: string
): Promise<CurrentReminderStaff> => {
  if (!Types.ObjectId.isValid(restaurantId)) {
    throw new BadRequestError("Invalid restaurantId");
  }

  const restaurant = await Restaurant.findById(restaurantId).select(
    "+wasenderApiToken name ownerName ownerPhone managerPhones managerContacts timezone status wasenderSessionId"
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
      "Only a verified owner or manager can manage personal reminders"
    );
  }

  return {
    restaurant,
    phone: sender.normalizedPhone,
    role: sender.role
  };
};

const requireReminderDeliveryConfiguration = (
  restaurant: IRestaurantDocument
): void => {
  if (!["trial", "active"].includes(restaurant.status)) {
    throw new BadRequestError(
      "Reminders cannot be scheduled for an inactive restaurant",
      "RESTAURANT_INACTIVE"
    );
  }

  if (
    !restaurant.wasenderSessionId?.trim() ||
    !restaurant.wasenderApiToken?.trim()
  ) {
    throw new BadRequestError(
      "WhatsApp delivery is not configured for this restaurant",
      "WASENDER_NOT_CONFIGURED"
    );
  }
};

const getMetadataString = (
  message: IOutboundMessageDocument,
  key: string
): string | undefined => {
  const value = message.metadata?.[key];
  return typeof value === "string" ? value : undefined;
};

const toStaffReminderView = (
  message: IOutboundMessageDocument
): StaffReminderView => ({
  reminderId: String(message._id),
  text: getMetadataString(message, "reminderText") ?? "",
  scheduledFor: new Date(
    getMetadataString(message, "scheduledFor") ?? message.nextAttemptAt
  ),
  status: message.status,
  createdAt: message.createdAt,
  ...(message.sentAt ? { sentAt: message.sentAt } : {})
});

const scopedReminderFilter = (
  reminderId: string,
  restaurantId: string,
  phone: string
): Record<string, unknown> => ({
  _id: reminderId,
  restaurantId,
  to: phone,
  "metadata.kind": "staff_reminder",
  "metadata.restaurantId": restaurantId,
  "metadata.createdByPhone": phone,
  "metadata.recipientPhone": phone
});

const getScopedReminder = async (
  reminderId: string,
  restaurantId: string,
  phone: string
): Promise<IOutboundMessageDocument> => {
  if (!Types.ObjectId.isValid(reminderId)) {
    throw new BadRequestError("Invalid reminderId");
  }

  const reminder = await OutboundMessage.findOne(
    scopedReminderFilter(reminderId, restaurantId, phone)
  );

  if (!reminder) {
    throw new NotFoundError("Reminder not found");
  }

  return reminder;
};

export const createStaffReminder = async (
  input: z.infer<typeof createStaffReminderSchema> & {
    restaurantId: string;
    senderPhone: string;
    requestId?: string;
  },
  now = new Date()
): Promise<StaffReminderView> => {
  const parsed = createStaffReminderSchema.parse({
    text: input.text,
    scheduledAt: input.scheduledAt
  });
  const staff = await loadCurrentReminderStaff(
    input.restaurantId,
    input.senderPhone
  );
  requireReminderDeliveryConfiguration(staff.restaurant);
  const scheduledFor = resolveZonedDateTime(
    parsed.scheduledAt,
    staff.restaurant.timezone || "Africa/Accra"
  );

  if (!scheduledFor || scheduledFor.getTime() <= now.getTime()) {
    throw new BadRequestError(
      "A reminder must be scheduled in the future",
      "REMINDER_TIME_NOT_FUTURE"
    );
  }

  const idempotencySuffix = input.requestId?.trim() || new Types.ObjectId();
  const message = await enqueueWasenderMessage({
    restaurantId: input.restaurantId,
    sessionId: staff.restaurant.wasenderSessionId,
    apiKey: staff.restaurant.wasenderApiToken,
    to: staff.phone,
    type: "text",
    text: `Reminder from OrderBridge:\n\n${parsed.text}.`,
    nextAttemptAt: scheduledFor,
    idempotencyKey: `staff-reminder:${input.restaurantId}:${staff.phone}:${idempotencySuffix}`,
    metadata: {
      kind: "staff_reminder",
      restaurantId: input.restaurantId,
      createdByPhone: staff.phone,
      createdByRole: staff.role,
      recipientPhone: staff.phone,
      recipientRole: staff.role,
      reminderText: parsed.text,
      scheduledFor: scheduledFor.toISOString()
    }
  });

  return toStaffReminderView(message);
};

export const listStaffReminders = async (
  input: z.infer<typeof listStaffRemindersSchema> & {
    restaurantId: string;
    senderPhone: string;
  }
): Promise<StaffReminderView[]> => {
  const parsed = listStaffRemindersSchema.parse({
    status: input.status,
    limit: input.limit
  });
  const staff = await loadCurrentReminderStaff(
    input.restaurantId,
    input.senderPhone
  );
  const reminders = await OutboundMessage.find({
    restaurantId: input.restaurantId,
    to: staff.phone,
    "metadata.kind": "staff_reminder",
    "metadata.restaurantId": input.restaurantId,
    "metadata.createdByPhone": staff.phone,
    "metadata.recipientPhone": staff.phone,
    ...(parsed.status ? { status: parsed.status } : {})
  })
    .sort({ nextAttemptAt: 1, createdAt: -1 })
    .limit(parsed.limit ?? 25);

  return reminders.map(toStaffReminderView);
};

export const rescheduleStaffReminder = async (
  input: z.infer<typeof rescheduleStaffReminderSchema> & {
    restaurantId: string;
    senderPhone: string;
  },
  now = new Date()
): Promise<StaffReminderView> => {
  const parsed = rescheduleStaffReminderSchema.parse({
    reminderId: input.reminderId,
    scheduledAt: input.scheduledAt
  });
  const staff = await loadCurrentReminderStaff(
    input.restaurantId,
    input.senderPhone
  );
  requireReminderDeliveryConfiguration(staff.restaurant);
  const scheduledFor = resolveZonedDateTime(
    parsed.scheduledAt,
    staff.restaurant.timezone || "Africa/Accra"
  );

  if (!scheduledFor || scheduledFor.getTime() <= now.getTime()) {
    throw new BadRequestError(
      "A reminder must be scheduled in the future",
      "REMINDER_TIME_NOT_FUTURE"
    );
  }

  const filter = scopedReminderFilter(
    parsed.reminderId,
    input.restaurantId,
    staff.phone
  );
  const updated = await OutboundMessage.findOneAndUpdate(
    { ...filter, status: "pending" },
    {
      $set: {
        nextAttemptAt: scheduledFor,
        "metadata.scheduledFor": scheduledFor.toISOString()
      }
    },
    { new: true, runValidators: true }
  );

  if (updated) {
    return toStaffReminderView(updated);
  }

  const reminder = await getScopedReminder(
    parsed.reminderId,
    input.restaurantId,
    staff.phone
  );
  const message =
    reminder.status === "sent"
      ? "That reminder has already been sent."
      : "Only pending reminders can be rescheduled.";
  throw new BadRequestError(message, "REMINDER_NOT_PENDING");
};

export const cancelStaffReminder = async (
  input: z.infer<typeof cancelStaffReminderSchema> & {
    restaurantId: string;
    senderPhone: string;
  },
  now = new Date()
): Promise<StaffReminderView> => {
  const parsed = cancelStaffReminderSchema.parse({
    reminderId: input.reminderId
  });
  const staff = await loadCurrentReminderStaff(
    input.restaurantId,
    input.senderPhone
  );
  const filter = scopedReminderFilter(
    parsed.reminderId,
    input.restaurantId,
    staff.phone
  );
  const cancelled = await OutboundMessage.findOneAndUpdate(
    { ...filter, status: "pending" },
    {
      $set: {
        status: "cancelled",
        lastAttemptAt: now,
        lastError: "Cancelled by reminder owner"
      }
    },
    { new: true, runValidators: true }
  );

  if (cancelled) {
    return toStaffReminderView(cancelled);
  }

  const reminder = await getScopedReminder(
    parsed.reminderId,
    input.restaurantId,
    staff.phone
  );

  if (reminder.status === "cancelled") {
    return toStaffReminderView(reminder);
  }

  const message =
    reminder.status === "sent"
      ? "That reminder has already been sent and cannot be cancelled."
      : "Only pending reminders can be cancelled.";
  throw new BadRequestError(message, "REMINDER_NOT_PENDING");
};
