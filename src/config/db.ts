import dns from "dns";
import mongoose from "mongoose";
import { env } from "./env";

const getMongoErrorMessage = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return "Unknown MongoDB connection error";
  }

  if (error.message.includes("querySrv")) {
    return "MongoDB SRV DNS lookup failed. Check your DNS/network or use MONGODB_DNS_SERVERS=8.8.8.8,1.1.1.1.";
  }

  if (error.message.includes("Could not connect to any servers")) {
    return "Could not connect to MongoDB Atlas. Check Atlas Network Access IP whitelist, database username/password, and internet access.";
  }

  return error.message;
};

export const connectDb = async (): Promise<void> => {
  try {
    if (env.mongodbUri.startsWith("mongodb+srv://") && env.mongodbDnsServers.length > 0) {
      dns.setServers(env.mongodbDnsServers);
    }

    await mongoose.connect(env.mongodbUri, {
      serverSelectionTimeoutMS: 10000
    });
    console.log("MongoDB connected successfully");
  } catch (error) {
    console.error(`MongoDB connection failed: ${getMongoErrorMessage(error)}`);

    if (env.debugDbErrors) {
      console.error(error);
    }

    process.exit(1);
  }
};
