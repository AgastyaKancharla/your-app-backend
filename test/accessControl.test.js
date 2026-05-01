const test = require("node:test");
const assert = require("node:assert/strict");

const {
  STAFF_ROLES,
  normalizeOrderStatus,
  canTransitionOrderStatus,
  buildOrderStatusFilter,
  isActiveOrderStatus,
  isCompletedOrderStatus
} = require("../utils/accessControl");

test("staff roles cover the newly supported team roles", () => {
  assert.deepEqual(STAFF_ROLES, [
    "MANAGER",
    "CASHIER",
    "KITCHEN",
    "INVENTORY_MANAGER",
    "DELIVERY_MANAGER",
    "DELIVERY_PARTNER",
    "MARKETING_MANAGER",
    "ACCOUNTANT",
    "WAITER"
  ]);
});

test("normalizeOrderStatus maps legacy pending orders into the new workflow", () => {
  assert.equal(normalizeOrderStatus("PENDING"), "NEW");
  assert.equal(normalizeOrderStatus("NEW_ORDER"), "NEW");
  assert.equal(normalizeOrderStatus("ACCEPTED"), "PREPARING");
  assert.equal(normalizeOrderStatus("OUT_FOR_DELIVERY"), "READY");
  assert.equal(normalizeOrderStatus("COMPLETED"), "DELIVERED");
  assert.equal(normalizeOrderStatus("preparing"), "PREPARING");
  assert.equal(normalizeOrderStatus(""), "NEW");
});

test("canTransitionOrderStatus only allows forward order workflow transitions", () => {
  assert.equal(canTransitionOrderStatus("NEW", "PREPARING"), true);
  assert.equal(canTransitionOrderStatus("PREPARING", "READY"), true);
  assert.equal(canTransitionOrderStatus("READY", "DELIVERED"), true);
  assert.equal(canTransitionOrderStatus("READY", "COMPLETED"), true);
  assert.equal(canTransitionOrderStatus("PREPARING", "PREPARING"), true);
  assert.equal(canTransitionOrderStatus("OUT_FOR_DELIVERY", "PREPARING"), false);
});

test("buildOrderStatusFilter includes legacy pending records for preparing orders", () => {
  assert.deepEqual(buildOrderStatusFilter("NEW"), {
    $in: ["NEW", "PENDING", "NEW_ORDER"]
  });
  assert.deepEqual(buildOrderStatusFilter("PREPARING"), {
    $in: ["PREPARING", "ACCEPTED"]
  });
  assert.deepEqual(buildOrderStatusFilter("PENDING"), {
    $nin: ["DELIVERED", "DISPATCHED", "COMPLETED", "DONE", "CANCELLED"]
  });
  assert.deepEqual(buildOrderStatusFilter("COMPLETED"), {
    $in: ["DELIVERED", "DISPATCHED", "COMPLETED", "DONE"]
  });
  assert.equal(buildOrderStatusFilter("ALL"), null);
});

test("active and completed helpers split the workflow correctly", () => {
  assert.equal(isActiveOrderStatus("ACCEPTED"), true);
  assert.equal(isActiveOrderStatus("PENDING"), true);
  assert.equal(isCompletedOrderStatus("COMPLETED"), true);
  assert.equal(isCompletedOrderStatus("READY"), false);
});
