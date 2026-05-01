const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeBusinessType,
  resolveWorkspaceAccess
} = require("../services/workspaceAccess");

test("normalizeBusinessType accepts cloud kitchen and restaurant variants", () => {
  assert.equal(normalizeBusinessType("cloud kitchen"), "CLOUD_KITCHEN");
  assert.equal(normalizeBusinessType("CLOUD-KITCHEN"), "CLOUD_KITCHEN");
  assert.equal(normalizeBusinessType("restaurant"), "RESTAURANT");
});

test("resolveWorkspaceAccess enables cloud kitchen operations on Growth", () => {
  const access = resolveWorkspaceAccess({
    restaurant: {
      businessType: "cloud kitchen",
      subscriptionPlan: "GROWTH",
      createdAt: "2026-03-01T00:00:00.000Z",
      subscriptionExpiry: "2026-04-01T00:00:00.000Z"
    },
    subscription: {
      plan: "GROWTH",
      status: "ACTIVE",
      startDate: "2026-03-01T00:00:00.000Z",
      expiryDate: "2026-04-01T00:00:00.000Z"
    },
    now: "2026-03-23T00:00:00.000Z"
  });

  assert.equal(access.businessType, "CLOUD_KITCHEN");
  assert.equal(access.isReadOnly, false);
  assert.ok(access.enabledPages.includes("DELIVERY"));
  assert.ok(access.enabledPages.includes("SALES_CHANNELS"));
  assert.ok(access.enabledPages.includes("PACKAGING"));
  assert.equal(access.enabledPages.includes("TABLES"), false);
});

test("resolveWorkspaceAccess marks expired trials as read-only and keeps restaurant modules", () => {
  const access = resolveWorkspaceAccess({
    restaurant: {
      businessType: "restaurant",
      subscriptionPlan: "PRO",
      createdAt: "2026-03-01T00:00:00.000Z",
      subscriptionExpiry: "2026-03-15T00:00:00.000Z"
    },
    subscription: {
      plan: "PRO",
      status: "TRIAL",
      startDate: "2026-03-01T00:00:00.000Z",
      trialEndsAt: "2026-03-15T00:00:00.000Z"
    },
    now: "2026-03-23T00:00:00.000Z"
  });

  assert.equal(access.status, "EXPIRED");
  assert.equal(access.isReadOnly, true);
  assert.ok(access.enabledPages.includes("TABLES"));
  assert.ok(access.enabledPages.includes("RESERVATIONS"));
  assert.equal(access.enabledPages.includes("DELIVERY"), false);
});
