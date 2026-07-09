import { app } from "./app";
import { connectDb } from "./config/db";
import { env } from "./config/env";

const startServer = async (): Promise<void> => {
  await connectDb();

  app.listen(env.port, () => {
    console.log(`OrderBridge AI backend listening on port ${env.port}`);
  });
};

void startServer();
