import { app } from "./app";
import { connectDb } from "./config/db";
import { env } from "./config/env";
import { startFollowUpScheduler } from "./services/followUp.service";
import { startOwnerPendingActionReminderScheduler } from "./services/ownerPendingActionReminder.service";
import { startOwnerSummaryScheduler } from "./services/ownerSummaryScheduler.service";
import { startCustomerCampaignScheduler } from "./services/customerCampaignScheduler.service";
import { startWasenderQueueWorker } from "./services/wasenderQueue.service";

const startServer = async (): Promise<void> => {
  await connectDb();

  app.listen(env.port, () => {
    console.log(`OrderBridge AI backend listening on port ${env.port}`);
  });
  startWasenderQueueWorker();
  startFollowUpScheduler();
  startOwnerSummaryScheduler();
  startOwnerPendingActionReminderScheduler();
  startCustomerCampaignScheduler();
};

void startServer();
