const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const getQuantityPerPack = (ingredientLine = {}) => {
  const value = toNumber(
    ingredientLine.quantityPerPack ??
      ingredientLine.quantityRequired ??
      ingredientLine.quantity
  );

  return Math.max(0, value);
};

const calculateIngredientDeduction = (ingredientLine = {}, orderedPacks = 0) => {
  const qtyPerPack = getQuantityPerPack(ingredientLine);
  const packs = Math.max(0, toNumber(orderedPacks));
  return Number((qtyPerPack * packs).toFixed(6));
};

module.exports = {
  getQuantityPerPack,
  calculateIngredientDeduction
};
