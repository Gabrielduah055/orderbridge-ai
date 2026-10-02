const assert = require("node:assert/strict");
const test = require("node:test");

const {
  formatDisplayDate,
  formatDisplayDateTime
} = require("../dist/utils/formatDisplay.util");

test("display date formatting uses the requested restaurant timezone", () => {
  const value = new Date("2026-08-11T23:30:00.000Z");

  assert.equal(formatDisplayDate(value), "11 August 2026");
  assert.equal(formatDisplayDate(value, "Africa/Lagos"), "12 August 2026");
});

test("display date-time formatting uses a stable 24-hour clock", () => {
  const value = new Date("2026-08-11T19:03:00.000Z");

  assert.equal(
    formatDisplayDateTime(value, "Africa/Accra"),
    "11 August 2026 at 19:03"
  );
  assert.equal(
    formatDisplayDateTime(value, "America/New_York"),
    "11 August 2026 at 15:03"
  );
});
