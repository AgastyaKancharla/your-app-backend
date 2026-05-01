const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveDashboardRange,
  formatHourWindow,
  calculateKitchenLoad,
  formatKitchenLoadLabel
} = require("../services/cloudKitchenDashboardService");

const getInclusiveDays = (startDate, endDate) => {
  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setHours(0, 0, 0, 0);
  return Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
};

test("resolveDashboardRange handles preset and custom ranges", () => {
  const now = new Date("2026-04-22T10:30:00.000Z");
  const preset = resolveDashboardRange({ range: "7d", now });
  const custom = resolveDashboardRange({
    range: "custom",
    from: "2026-04-01",
    to: "2026-04-10",
    now
  });

  assert.equal(preset.key, "7d");
  assert.equal(getInclusiveDays(preset.startDate, preset.endDate), 7);
  assert.equal(custom.key, "custom");
  assert.equal(getInclusiveDays(custom.startDate, custom.endDate), 10);
});

test("formatHourWindow renders a human-readable prediction window", () => {
  const label = formatHourWindow(19);
  assert.match(label, /7:00|19:00/);
});

test("calculateKitchenLoad weights queue, delay, and prep pressure", () => {
  const stableLoad = calculateKitchenLoad({
    activeOrders: 2,
    delayedOrders: 0,
    avgPrepTime: 7
  });
  const criticalLoad = calculateKitchenLoad({
    activeOrders: 11,
    delayedOrders: 3,
    avgPrepTime: 24
  });

  assert.ok(stableLoad < criticalLoad);
  assert.equal(formatKitchenLoadLabel(stableLoad), "Stable");
  assert.equal(formatKitchenLoadLabel(criticalLoad), "Critical");
});
