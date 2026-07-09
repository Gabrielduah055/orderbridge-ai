import dotenv from "dotenv";

dotenv.config();

const requiredEnv = [
  "PORT",
  "NODE_ENV",
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY"
] as const;

const missingEnv = requiredEnv.filter((key) => !process.env[key]);
const mongodbUri = process.env.MONGODB_URI || process.env.MONGODB_URL || process.env.MONGO_URL;

if (!mongodbUri) {
  missingEnv.push("MONGODB_URI" as (typeof requiredEnv)[number]);
}

if (missingEnv.length > 0) {
  throw new Error(`Missing required environment variables: ${missingEnv.join(", ")}`);
}

export const env = {
  port: Number(process.env.PORT),
  nodeEnv: process.env.NODE_ENV as "development" | "production" | "test",
  mongodbUri: mongodbUri as string,
  mongodbDnsServers: process.env.MONGODB_DNS_SERVERS
    ? process.env.MONGODB_DNS_SERVERS.split(",")
        .map((server) => server.trim())
        .filter(Boolean)
    : ["8.8.8.8", "1.1.1.1"],
  debugDbErrors: process.env.DEBUG_DB_ERRORS === "true",
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID as string,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL as string,
    privateKey: (process.env.FIREBASE_PRIVATE_KEY as string).replace(/\\n/g, "\n")
  }
};
