const assert = require("node:assert/strict");
const test = require("node:test");

const { resolveSenderIdentity } = require("../dist/services/senderIdentity.service");
const {
  isToolAllowedForRole,
  getAllowedToolNamesForRole
} = require("../dist/agent-tools/tool.permissions");

const restaurant = {
  ownerName: "Gabriel",
  ownerPhone: "+233507879374",
  managerPhones: ["0507879375"],
  managerContacts: [{ name: "Ama", phone: "233507879376" }]
};

test("owner number resolves to owner", () => {
  const sender = resolveSenderIdentity(restaurant, "0507879374");

  assert.equal(sender.role, "owner");
  assert.equal(sender.verified, true);
  assert.equal(sender.name, "Gabriel");
  assert.equal(sender.normalizedPhone, "+233507879374");
});

test("manager number resolves to manager from managerPhones", () => {
  const sender = resolveSenderIdentity(restaurant, "+233507879375");

  assert.equal(sender.role, "manager");
  assert.equal(sender.verified, true);
});

test("manager number resolves to manager from managerContacts", () => {
  const sender = resolveSenderIdentity(restaurant, "0507879376");

  assert.equal(sender.role, "manager");
  assert.equal(sender.verified, true);
  assert.equal(sender.name, "Ama");
});

test("unknown number resolves to customer", () => {
  const sender = resolveSenderIdentity(restaurant, "233557038547");

  assert.equal(sender.role, "customer");
  assert.equal(sender.verified, false);
  assert.equal(sender.normalizedPhone, "+233557038547");
});

test("customers and managers cannot update menu prices", () => {
  assert.equal(isToolAllowedForRole("update_menu_price", "customer"), false);
  assert.equal(isToolAllowedForRole("update_menu_price", "manager"), false);
});

test("owner can prepare a menu price update", () => {
  assert.equal(isToolAllowedForRole("update_menu_price", "owner"), true);
});

test("unsupported promotion tool is not exposed", () => {
  assert.equal(isToolAllowedForRole("create_promotion", "owner"), false);
  assert.equal(getAllowedToolNamesForRole("owner").includes("create_promotion"), false);
});
