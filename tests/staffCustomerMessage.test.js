const assert = require("node:assert/strict");
const test = require("node:test");

const { CustomerProfile } = require("../dist/models/customerProfile.model");
const { OutboundMessage } = require("../dist/models/outboundMessage.model");
const {
  PendingAgentAction
} = require("../dist/models/pendingAgentAction.model");
const { Restaurant } = require("../dist/models/Restaurant");
const {
  executeAgentTool,
  executeConfirmedPendingToolAction
} = require("../dist/agent-tools/tool.executor");
const {
  isToolAllowedForRole
} = require("../dist/agent-tools/tool.permissions");
const {
  getAgentToolDefinitionsForRole
} = require("../dist/services/ai/agentToolDefinitions.service");
const {
  getQueuedStaffDirectMessageStaleReason,
  isTransactionalQueuedMessage
} = require("../dist/services/wasenderQueue.service");
const {
  enqueueStaffCustomerMessage
} = require("../dist/services/staffCustomerMessage.service");

const restaurantId = "64b000000000000000000d01";
const otherRestaurantId = "64b000000000000000000d02";
const profileId = "64b000000000000000000d11";
const pendingActionId = "64b000000000000000000d21";
const ownerPhone = "+233507879374";
const managerPhone = "+233241234567";
const customerPhone = "+233557038547";

const makeRestaurant = (overrides = {}) => ({
  _id: restaurantId,
  name: "Direct Message Restaurant",
  ownerName: "Owner",
  ownerPhone,
  managerPhones: [managerPhone],
  managerContacts: [],
  status: "active",
  timezone: "Africa/Accra",
  wasenderSessionId: "wasender-session-1",
  wasenderApiToken: "restaurant-token",
  ...overrides
});

const makeContext = (role = "owner") => ({
  restaurantId,
  restaurant: makeRestaurant(),
  sender: {
    role,
    verified: role !== "customer",
    phone: role === "manager" ? managerPhone : ownerPhone,
    normalizedAddress: role === "manager" ? managerPhone : ownerPhone,
    normalizedPhone: role === "manager" ? managerPhone : ownerPhone
  },
  requestId: "direct-message-request-1"
});

const profileQuery = (profiles, captureFilter) => (filter) => {
  captureFilter(filter);
  return {
    select() {
      return {
        limit: async () => profiles
      };
    }
  };
};

test("send_customer_message is exposed only to owner and manager roles", async () => {
  assert.equal(isToolAllowedForRole("send_customer_message", "owner"), true);
  assert.equal(isToolAllowedForRole("send_customer_message", "manager"), true);
  assert.equal(isToolAllowedForRole("send_customer_message", "customer"), false);

  const ownerTools = getAgentToolDefinitionsForRole("owner").map(
    (tool) => tool.function.name
  );
  const managerTools = getAgentToolDefinitionsForRole("manager").map(
    (tool) => tool.function.name
  );
  const customerTools = getAgentToolDefinitionsForRole("customer").map(
    (tool) => tool.function.name
  );
  assert.equal(ownerTools.includes("send_customer_message"), true);
  assert.equal(managerTools.includes("send_customer_message"), true);
  assert.equal(customerTools.includes("send_customer_message"), false);

  const forbidden = await executeAgentTool(
    "send_customer_message",
    { customerName: "Lady Ruth", message: "We are active." },
    makeContext("customer")
  );
  assert.equal(forbidden.success, false);
  assert.equal(forbidden.code, "TOOL_FORBIDDEN");
});

test("direct customer message preview is tenant-scoped and confirmation queues exactly the bound profile", async () => {
  const originals = {
    restaurantFindById: Restaurant.findById,
    profileFind: CustomerProfile.find,
    profileFindOne: CustomerProfile.findOne,
    pendingUpdateMany: PendingAgentAction.updateMany,
    pendingCreate: PendingAgentAction.create,
    pendingFindOne: PendingAgentAction.findOne,
    outboundFindOne: OutboundMessage.findOne,
    outboundCreate: OutboundMessage.create
  };
  const profile = {
    _id: profileId,
    customerPhone,
    customerName: "Lady Ruth",
    isOptedOut: false
  };
  let previewFilter;
  let confirmationFilter;
  let pendingCreateInput;
  let outboundCreateInput;

  try {
    Restaurant.findById = (id) => ({
      select: async () => {
        assert.equal(String(id), restaurantId);
        return makeRestaurant();
      }
    });
    CustomerProfile.find = profileQuery([profile], (filter) => {
      previewFilter = filter;
    });
    PendingAgentAction.updateMany = async () => ({ modifiedCount: 0 });
    PendingAgentAction.create = async (input) => {
      pendingCreateInput = input;
      return { _id: pendingActionId };
    };

    const preview = await executeAgentTool(
      "send_customer_message",
      { customerName: "Lady Ruth", message: "We are active." },
      makeContext("owner")
    );

    assert.equal(preview.success, true);
    assert.equal(preview.requiresConfirmation, true);
    assert.equal(preview.pendingActionId, pendingActionId);
    assert.equal(previewFilter.restaurantId, restaurantId);
    assert.equal(pendingCreateInput.arguments.customerName, "Lady Ruth");
    assert.equal(
      Object.hasOwn(pendingCreateInput.arguments, "customerProfileId"),
      false
    );
    assert.equal(pendingCreateInput.data.customerProfileId, profileId);
    assert.equal(pendingCreateInput.data.customerPhone, customerPhone);
    assert.match(preview.message, /Lady Ruth/);
    assert.match(preview.message, /\*\*\*8547/);

    const pending = {
      _id: pendingActionId,
      toolName: "send_customer_message",
      arguments: pendingCreateInput.arguments,
      data: pendingCreateInput.data,
      status: "pending",
      async save() {
        return this;
      }
    };
    PendingAgentAction.findOne = async (filter) => {
      assert.equal(filter.restaurantId, restaurantId);
      return pending;
    };
    CustomerProfile.findOne = (filter) => {
      confirmationFilter = filter;
      return { select: async () => profile };
    };
    OutboundMessage.findOne = () => ({ select: async () => null });
    OutboundMessage.create = async (input) => {
      outboundCreateInput = input;
      return { _id: "queue-1", status: "pending" };
    };

    const confirmed = await executeConfirmedPendingToolAction(
      pendingActionId,
      makeContext("owner"),
      "send_customer_message"
    );

    assert.equal(confirmed.success, true);
    assert.equal(confirmationFilter._id, profileId);
    assert.equal(confirmationFilter.restaurantId, restaurantId);
    assert.equal(outboundCreateInput.restaurantId, restaurantId);
    assert.equal(outboundCreateInput.to, customerPhone);
    assert.equal(outboundCreateInput.text, "We are active.");
    assert.equal(outboundCreateInput.metadata.kind, "staff_direct_message");
    assert.equal(outboundCreateInput.metadata.customerProfileId, profileId);
    assert.equal(outboundCreateInput.metadata.createdByPhone, ownerPhone);
    assert.equal(
      outboundCreateInput.idempotencyKey,
      `staff-direct-message:${restaurantId}:${pendingActionId}`
    );
    assert.equal(pending.status, "completed");
  } finally {
    Restaurant.findById = originals.restaurantFindById;
    CustomerProfile.find = originals.profileFind;
    CustomerProfile.findOne = originals.profileFindOne;
    PendingAgentAction.updateMany = originals.pendingUpdateMany;
    PendingAgentAction.create = originals.pendingCreate;
    PendingAgentAction.findOne = originals.pendingFindOne;
    OutboundMessage.findOne = originals.outboundFindOne;
    OutboundMessage.create = originals.outboundCreate;
  }
});

test("same-name direct message lookup returns masked clarification without queueing", async () => {
  const originals = {
    restaurantFindById: Restaurant.findById,
    profileFind: CustomerProfile.find,
    pendingCreate: PendingAgentAction.create
  };
  let pendingCreates = 0;

  try {
    Restaurant.findById = () => ({
      select: async () => makeRestaurant()
    });
    CustomerProfile.find = profileQuery(
      [
        {
          _id: profileId,
          customerPhone,
          customerName: "Lady Ruth",
          isOptedOut: false
        },
        {
          _id: "64b000000000000000000d12",
          customerPhone: "+233501112222",
          customerName: "Lady Ruth",
          isOptedOut: false
        }
      ],
      (filter) => assert.equal(filter.restaurantId, restaurantId)
    );
    PendingAgentAction.create = async () => {
      pendingCreates += 1;
    };

    const result = await executeAgentTool(
      "send_customer_message",
      { customerName: "Lady Ruth", message: "We are active." },
      makeContext("manager")
    );

    assert.equal(result.success, false);
    assert.equal(result.code, "STAFF_DIRECT_MESSAGE_CUSTOMER_AMBIGUOUS");
    assert.match(result.message, /\*\*\*8547/);
    assert.match(result.message, /\*\*\*2222/);
    assert.equal(pendingCreates, 0);
  } finally {
    Restaurant.findById = originals.restaurantFindById;
    CustomerProfile.find = originals.profileFind;
    PendingAgentAction.create = originals.pendingCreate;
  }
});

test("repeated confirmed direct messages reuse one idempotent queue row", async () => {
  const originals = {
    restaurantFindById: Restaurant.findById,
    profileFindOne: CustomerProfile.findOne,
    outboundFindOne: OutboundMessage.findOne,
    outboundCreate: OutboundMessage.create
  };
  const profile = {
    _id: profileId,
    customerPhone,
    customerName: "Lady Ruth",
    isOptedOut: false
  };
  let existing = null;
  let creates = 0;

  try {
    Restaurant.findById = () => ({
      select: async () => makeRestaurant()
    });
    CustomerProfile.findOne = () => ({ select: async () => profile });
    OutboundMessage.findOne = () => ({ select: async () => existing });
    OutboundMessage.create = async (input) => {
      creates += 1;
      existing = { ...input, _id: "queue-1", status: "pending" };
      return existing;
    };
    const input = {
      restaurantId,
      senderPhone: ownerPhone,
      message: "We are active.",
      pendingActionId,
      customerProfileId: profileId,
      expectedCustomerPhone: customerPhone
    };

    const first = await enqueueStaffCustomerMessage(input);
    const duplicate = await enqueueStaffCustomerMessage(input);

    assert.equal(first.status, "pending");
    assert.equal(duplicate.status, "pending");
    assert.equal(creates, 1);
    assert.equal(
      existing.idempotencyKey,
      `staff-direct-message:${restaurantId}:${pendingActionId}`
    );
  } finally {
    Restaurant.findById = originals.restaurantFindById;
    CustomerProfile.findOne = originals.profileFindOne;
    OutboundMessage.findOne = originals.outboundFindOne;
    OutboundMessage.create = originals.outboundCreate;
  }
});

test("staff direct queue entries are transactional and revalidate opt-out and staff authorization", async () => {
  const originals = {
    profileFindOne: CustomerProfile.findOne,
    restaurantFindOne: Restaurant.findOne
  };
  let profileFilter;
  let restaurantFilter;
  let currentProfile = {
    _id: profileId,
    customerPhone,
    isOptedOut: false
  };
  let currentRestaurant = makeRestaurant();
  const metadata = {
    kind: "staff_direct_message",
    restaurantId,
    customerProfileId: profileId,
    customerPhone,
    createdByPhone: ownerPhone,
    createdByRole: "owner"
  };

  try {
    CustomerProfile.findOne = (filter) => {
      profileFilter = filter;
      return { select: async () => currentProfile };
    };
    Restaurant.findOne = (filter) => {
      restaurantFilter = filter;
      return { select: async () => currentRestaurant };
    };

    assert.equal(isTransactionalQueuedMessage(metadata), true);
    assert.equal(
      await getQueuedStaffDirectMessageStaleReason(
        metadata,
        customerPhone,
        "wasender-session-1",
        "restaurant-token",
        restaurantId
      ),
      null
    );
    assert.equal(profileFilter._id, profileId);
    assert.equal(profileFilter.restaurantId, restaurantId);
    assert.equal(restaurantFilter._id, restaurantId);

    currentProfile = { ...currentProfile, isOptedOut: true };
    assert.equal(
      await getQueuedStaffDirectMessageStaleReason(
        metadata,
        customerPhone,
        "wasender-session-1",
        "restaurant-token",
        restaurantId
      ),
      "customer_opted_out"
    );

    currentProfile = { ...currentProfile, isOptedOut: false };
    currentRestaurant = makeRestaurant({
      ownerPhone: "+233500000000",
      managerPhones: [],
      managerContacts: []
    });
    assert.equal(
      await getQueuedStaffDirectMessageStaleReason(
        metadata,
        customerPhone,
        "wasender-session-1",
        "restaurant-token",
        restaurantId
      ),
      "staff_no_longer_authorized"
    );

    assert.equal(
      await getQueuedStaffDirectMessageStaleReason(
        { ...metadata, restaurantId: otherRestaurantId },
        customerPhone,
        "wasender-session-1",
        "restaurant-token",
        restaurantId
      ),
      "queued_restaurant_changed"
    );
  } finally {
    CustomerProfile.findOne = originals.profileFindOne;
    Restaurant.findOne = originals.restaurantFindOne;
  }
});
