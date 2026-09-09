import { CustomerProfile } from "./customerProfile.model";
import { CustomerSession } from "./customerSession.model";

interface CustomerIdentityIndexDescription {
  name?: string;
  unique?: boolean;
  key: Record<string, unknown>;
}

type CustomerIdentityIndexCollection = Pick<
  typeof CustomerSession.collection,
  "createIndex" | "indexes" | "dropIndex"
>;

export interface EnsureCustomerIdentityIndexesDependencies {
  sessionCollection?: CustomerIdentityIndexCollection;
  profileCollection?: CustomerIdentityIndexCollection;
}

const stableKeyIndex = { restaurantId: 1, customerKey: 1 } as const;
const stableKeyIndexOptions = {
  unique: true,
  partialFilterExpression: { customerKey: { $type: "string" } }
} as const;

const isObsoleteUniqueRecipientIndex = (
  index: CustomerIdentityIndexDescription
): boolean => {
  const keys = Object.entries(index.key);

  return (
    index.unique === true &&
    keys.length === 2 &&
    index.key.restaurantId === 1 &&
    index.key.customerPhone === 1
  );
};

const ensureCollectionIdentityIndexes = async (
  collection: CustomerIdentityIndexCollection,
  lookupIndexName: string
): Promise<void> => {
  await collection.createIndex(stableKeyIndex, stableKeyIndexOptions);

  // This replacement can coexist with the legacy unique two-field index, so
  // lookups stay indexed before the obsolete constraint is removed.
  await collection.createIndex(
    { restaurantId: 1, customerPhone: 1, customerKey: 1 },
    { name: lookupIndexName }
  );

  const indexes = await collection.indexes();
  for (const index of indexes) {
    if (isObsoleteUniqueRecipientIndex(index) && index.name) {
      await collection.dropIndex(index.name);
    }
  }
};

export const ensureCustomerIdentityIndexes = async (
  dependencies: EnsureCustomerIdentityIndexesDependencies = {}
): Promise<void> => {
  await ensureCollectionIdentityIndexes(
    dependencies.sessionCollection ?? CustomerSession.collection,
    "customer_session_recipient_lookup"
  );
  await ensureCollectionIdentityIndexes(
    dependencies.profileCollection ?? CustomerProfile.collection,
    "customer_profile_recipient_lookup"
  );
};
