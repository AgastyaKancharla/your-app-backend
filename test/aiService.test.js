const assert = require("node:assert/strict");
const test = require("node:test");

const { buildItemSummary, normalizeInsightPayload } = require("../services/aiService");

test("buildItemSummary ranks top and low items from recent orders", () => {
  const summary = buildItemSummary([
    {
      totalAmount: 300,
      items: [
        { name: "Biryani", quantity: 2, price: 150 },
        { name: "Meals", quantity: 1, price: 120 }
      ]
    },
    {
      totalAmount: 270,
      items: [
        { name: "Biryani", quantity: 1, price: 150 },
        { name: "Soup", quantity: 1, price: 90 }
      ]
    }
  ]);

  assert.equal(summary.topItems[0].name, "Biryani");
  assert.equal(summary.topItems[0].quantity, 3);
  assert.equal(summary.lowItems[0].quantity, 1);
  assert.equal(summary.totalOrders, 2);
});

test("normalizeInsightPayload accepts snake_case model output", () => {
  const normalized = normalizeInsightPayload({
    what_to_sell: ["Chicken Biryani", "Chicken Biryani", "Meals"],
    menu_improvements: ["Remove slow seller"],
    pricing_strategy: ["Bundle lunch offers"],
    marketing_ideas: ["Push weekday combo"],
    campaign_message: "Today special combo available."
  });

  assert.deepEqual(normalized.whatToSell, ["Chicken Biryani", "Meals"]);
  assert.deepEqual(normalized.menuImprovements, ["Remove slow seller"]);
  assert.equal(normalized.campaignMessage, "Today special combo available.");
});
