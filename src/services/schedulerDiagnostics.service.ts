import { Restaurant } from "../models/Restaurant";

interface RestaurantDiagnosticRecord {
  _id: unknown;
  name?: string;
}

export const logScheduledMessagingCredentialDiagnostics = async (): Promise<void> => {
  const [missingSessions, missingTokens] = await Promise.all([
    Restaurant.find({
      $or: [
        { wasenderSessionId: { $exists: false } },
        { wasenderSessionId: "" }
      ]
    })
      .select("_id name")
      .lean<RestaurantDiagnosticRecord[]>(),
    Restaurant.find({
      $or: [
        { wasenderApiToken: { $exists: false } },
        { wasenderApiToken: "" }
      ]
    })
      .select("_id name")
      .lean<RestaurantDiagnosticRecord[]>()
  ]);
  const skipped = new Map<
    string,
    { restaurantName: string; missingCredentials: Set<string> }
  >();

  const recordMissing = (
    restaurants: RestaurantDiagnosticRecord[],
    credential: "wasenderSessionId" | "wasenderApiToken"
  ): void => {
    for (const restaurant of restaurants) {
      const restaurantId = String(restaurant._id);
      const entry = skipped.get(restaurantId) ?? {
        restaurantName: restaurant.name || "(unnamed)",
        missingCredentials: new Set<string>()
      };
      entry.missingCredentials.add(credential);
      skipped.set(restaurantId, entry);
    }
  };

  recordMissing(missingSessions, "wasenderSessionId");
  recordMissing(missingTokens, "wasenderApiToken");

  for (const [restaurantId, diagnostic] of skipped) {
    console.warn("[schedulerCredentials] Restaurant excluded from scheduled messaging", {
      restaurantId,
      restaurantName: diagnostic.restaurantName,
      missingCredentials: Array.from(diagnostic.missingCredentials)
    });
  }

  console.info("[schedulerCredentials] Startup check", {
    restaurantsMissingCredentials: skipped.size
  });
};
