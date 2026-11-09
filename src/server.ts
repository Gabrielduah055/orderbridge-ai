import { app } from "./app";
import { connectDb } from "./config/db";
import { env } from "./config/env";
import { startFollowUpScheduler } from "./services/followUp.service";
import { startOwnerPendingActionReminderScheduler } from "./services/ownerPendingActionReminder.service";
import { startOwnerSummaryScheduler } from "./services/ownerSummaryScheduler.service";
import { startCustomerCampaignScheduler } from "./services/customerCampaignScheduler.service";
import { startOrderFeedbackScheduler } from "./services/orderFeedbackScheduler.service";
import { startWasenderQueueWorker } from "./services/wasenderQueue.service";
import { logScheduledMessagingCredentialDiagnostics } from "./services/schedulerDiagnostics.service";
import { startSubscriptionBillingScheduler } from "./services/subscriptionBilling.service";
import { startAdminAuditRetryWorker } from "./services/adminAudit.service";
import { startCommercePaidOrderNotificationWorker } from "./services/commercePaidOrderNotification.service";
import { startCommerceReceiptWorker } from "./services/commerceReceiptGeneration.service";
import { startCommerceReviewInvitationWorker } from "./services/commerceReviewInvitation.service";
import { startCommerceWhatsappWebhookWorker } from "./services/commerceWhatsappWebhook.service";

const startServer = async (): Promise<void> => {
  await connectDb();

  app.listen(env.port, () => {
    console.log(`OrderBridge AI backend listening on port ${env.port}`);
  });
  startWasenderQueueWorker();
  startCommerceWhatsappWebhookWorker();
  startCommercePaidOrderNotificationWorker();
  startCommerceReceiptWorker();
  startCommerceReviewInvitationWorker();
  void logScheduledMessagingCredentialDiagnostics().catch((error) => {
    console.error("[schedulerCredentials] Startup check failed", {
      error: error instanceof Error ? error.message : "Unknown scheduler credential diagnostic error"
    });
  });
  startFollowUpScheduler();
  startOwnerSummaryScheduler();
  startOwnerPendingActionReminderScheduler();
  startCustomerCampaignScheduler();
  startOrderFeedbackScheduler();
  startSubscriptionBillingScheduler();
  startAdminAuditRetryWorker();
};

void startServer();
