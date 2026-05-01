const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getQuantityPerPack,
  calculateIngredientDeduction
} = require("../utils/recipeQuantities");

test("getQuantityPerPack prefers quantityPerPack over fallback fields", () => {
  const value = getQuantityPerPack({
    quantityPerPack: 0.25,
    quantityRequired: 0.5,
    quantity: 1
  });
  assert.equal(value, 0.25);
});

test("getQuantityPerPack falls back to legacy fields", () => {
  const value = getQuantityPerPack({
    quantityRequired: 0.4
  });
  assert.equal(value, 0.4);
});

test("getQuantityPerPack never returns negative values", () => {
  const value = getQuantityPerPack({
    quantityPerPack: -5
  });
  assert.equal(value, 0);
});

test("calculateIngredientDeduction multiplies qty-per-pack with ordered pack count", () => {
  const deduction = calculateIngredientDeduction(
    {
      quantityPerPack: 0.2
    },
    3
  );
  assert.equal(deduction, 0.6);
});

test("calculateIngredientDeduction handles invalid order quantity safely", () => {
  const deduction = calculateIngredientDeduction(
    {
      quantityPerPack: 1.5
    },
    "not-a-number"
  );
  assert.equal(deduction, 0);
});
