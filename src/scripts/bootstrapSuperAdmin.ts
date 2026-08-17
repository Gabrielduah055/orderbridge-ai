import mongoose from "mongoose";
import { connectDb } from "../config/db";
import { firebaseAdmin } from "../config/firebase";
import { User } from "../models/User";

const getEmailArgument = (): string | undefined => {
  const argument = process.argv.find((value) => value.startsWith("--email="));
  return argument?.slice("--email=".length).trim().toLowerCase();
};

const fail = (message: string): never => {
  throw new Error(message);
};

const bootstrap = async (): Promise<void> => {
  const email = getEmailArgument();

  const verifiedEmail = email ?? fail("Usage: npm run bootstrap:superadmin -- --email=<email>");

  const firebaseUser = await firebaseAdmin.auth().getUserByEmail(verifiedEmail).catch((error: unknown) => {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    if (code === "auth/user-not-found") {
      fail(`No Firebase user exists for ${verifiedEmail}. Create or sign in with that Firebase account first, then rerun this command.`);
    }
    throw error;
  });

  await connectDb();

  const conflictingUser = await User.findOne({
    $or: [{ firebaseUid: firebaseUser.uid }, { email: verifiedEmail }]
  });

  if (
    conflictingUser &&
    (conflictingUser.firebaseUid !== firebaseUser.uid || conflictingUser.email !== verifiedEmail)
  ) {
    fail("A different OrderBridge user already owns this Firebase UID or email. Resolve the record conflict before bootstrapping.");
  }

  const user = await User.findOneAndUpdate(
    { firebaseUid: firebaseUser.uid },
    {
      $set: {
        name: firebaseUser.displayName?.trim() || "Super Admin",
        email: verifiedEmail,
        role: "super_admin",
        isActive: true
      },
      $setOnInsert: { firebaseUid: firebaseUser.uid }
    },
    { new: true, upsert: true, runValidators: true }
  );

  console.log(`Super admin ready: ${user.email} (${user.firebaseUid})`);
};

void bootstrap()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Unable to bootstrap the super admin");
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
