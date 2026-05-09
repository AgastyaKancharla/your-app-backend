const Recipe = require("../models/Recipe");
const RecipeVersion = require("../models/RecipeVersion");
const RawMaterial = require("../models/RawMaterial");
const PrepItem = require("../models/PrepItem");
const { getUnitCost, normalizeItemType } = require("./inventoryMovementService");

const normalizeText = (value = "") => String(value || "").trim();
const normalizeName = (value = "") => normalizeText(value).toLowerCase();
const escapeRegex = (value = "") => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const getIngredientModel = (ingredientType) =>
  normalizeItemType(ingredientType) === "prep_item" ? PrepItem : RawMaterial;

const normalizeVariantKey = (variantId = "", variantName = "") =>
  normalizeText(variantId || variantName).toLowerCase();

const normalizeVersionIngredients = (ingredients = []) =>
  (Array.isArray(ingredients) ? ingredients : [])
    .map((ingredient) => ({
      ingredientId: ingredient.ingredientId || ingredient.itemId || ingredient.inventoryId,
      ingredientType: normalizeItemType(ingredient.ingredientType || ingredient.itemType || "raw_material"),
      ingredientName: normalizeText(ingredient.ingredientName || ingredient.name),
      quantity: Math.max(0, toNumber(ingredient.quantity ?? ingredient.quantityPerPack)),
      unit: normalizeText(ingredient.unit) || "kg",
      isCritical: ingredient.isCritical === undefined ? true : Boolean(ingredient.isCritical)
    }))
    .filter((ingredient) => ingredient.ingredientId && ingredient.quantity > 0);

const ensureRecipe = async ({ restaurantId, menuItemId, menuItem, session = null }) => {
  let recipe = await Recipe.findOne({ restaurantId, menuItemId }).session(session);
  if (!recipe && menuItem) {
    recipe = await Recipe.findOne({
      restaurantId,
      menuItem: { $regex: new RegExp(`^${escapeRegex(menuItem)}$`, "i") }
    }).session(session);
  }

  if (recipe) {
    return recipe;
  }

  const created = await Recipe.create(
    [
      {
        restaurantId,
        menuItemId,
        menuItem: menuItem || "Menu item",
        ingredients: []
      }
    ],
    { session }
  );
  return created[0];
};

const createRecipeVersion = async ({
  restaurantId,
  menuItemId,
  menuItem,
  variantId = "",
  variantName = "",
  ingredients = [],
  yieldQuantity = 1,
  preparationLossPercent = 0,
  createdBy = null,
  session = null
}) => {
  const cleanIngredients = normalizeVersionIngredients(ingredients);
  if (!menuItemId) {
    const error = new Error("menuItemId is required");
    error.status = 400;
    throw error;
  }
  if (!cleanIngredients.length) {
    const error = new Error("At least one recipe ingredient is required");
    error.status = 400;
    throw error;
  }

  const recipe = await ensureRecipe({ restaurantId, menuItemId, menuItem, session });
  const normalizedVariantId = normalizeText(variantId || variantName);
  const latest = await RecipeVersion.findOne({
    restaurantId,
    recipeId: recipe._id,
    variantId: normalizedVariantId
  })
    .sort({ version: -1 })
    .session(session);
  const version = Number(latest?.version || 0) + 1;

  await RecipeVersion.updateMany(
    { restaurantId, recipeId: recipe._id, variantId: normalizedVariantId, active: true },
    { $set: { active: false } },
    { session }
  );

  const created = await RecipeVersion.create(
    [
      {
        restaurantId,
        recipeId: recipe._id,
        version,
        menuItemId,
        variantId: normalizedVariantId,
        variantName: normalizeText(variantName || variantId),
        ingredients: cleanIngredients,
        yieldQuantity: Math.max(0.0001, toNumber(yieldQuantity, 1)),
        preparationLossPercent: Math.min(100, Math.max(0, toNumber(preparationLossPercent))),
        createdBy,
        active: true
      }
    ],
    { session }
  );

  recipe.menuItemId = menuItemId;
  recipe.menuItem = menuItem || recipe.menuItem;
  recipe.ingredients = cleanIngredients
    .filter((ingredient) => ingredient.ingredientType === "raw_material")
    .map((ingredient) => ({
      itemId: ingredient.ingredientId,
      inventoryId: ingredient.ingredientId,
      ingredientName: ingredient.ingredientName,
      quantity: ingredient.quantity,
      quantityRequired: ingredient.quantity,
      quantityPerPack: ingredient.quantity,
      unit: ingredient.unit
    }));
  await recipe.save({ session });

  return created[0];
};

const findActiveRecipeVersion = async ({ restaurantId, menuItemId, variantId = "", variantName = "" }) => {
  if (!menuItemId) {
    return null;
  }

  const variantKey = normalizeVariantKey(variantId, variantName);
  const exact = await RecipeVersion.findOne({
    restaurantId,
    menuItemId,
    variantId: variantKey,
    active: true
  }).sort({ version: -1 });
  if (exact) {
    return exact;
  }

  return RecipeVersion.findOne({
    restaurantId,
    menuItemId,
    active: true,
    $or: [{ variantId: "" }, { variantId: { $exists: false } }]
  }).sort({ version: -1 });
};

const calculateRecipeCosting = async ({ restaurantId, recipeVersion }) => {
  const lines = [];
  let totalCost = 0;

  for (const ingredient of recipeVersion?.ingredients || []) {
    const Model = getIngredientModel(ingredient.ingredientType);
    const item = await Model.findOne({ restaurantId, _id: ingredient.ingredientId }).lean();
    const costPerUnit = getUnitCost(item || {}, ingredient.ingredientType);
    const lossMultiplier = 1 + toNumber(recipeVersion.preparationLossPercent) / 100;
    const adjustedQuantity = Number((toNumber(ingredient.quantity) * lossMultiplier).toFixed(4));
    const lineCost = Number((adjustedQuantity * costPerUnit).toFixed(4));
    totalCost += lineCost;
    lines.push({
      ingredientId: ingredient.ingredientId,
      ingredientType: ingredient.ingredientType,
      ingredientName: ingredient.ingredientName || item?.name || "",
      quantity: adjustedQuantity,
      unit: ingredient.unit,
      costPerUnit,
      totalCost: lineCost,
      isCritical: ingredient.isCritical
    });
  }

  const yieldQuantity = Math.max(0.0001, toNumber(recipeVersion?.yieldQuantity, 1));
  return {
    recipeVersionId: recipeVersion?._id || null,
    totalCost: Number(totalCost.toFixed(4)),
    unitCost: Number((totalCost / yieldQuantity).toFixed(4)),
    yieldQuantity,
    ingredients: lines
  };
};

module.exports = {
  calculateRecipeCosting,
  createRecipeVersion,
  findActiveRecipeVersion,
  normalizeName,
  normalizeVersionIngredients
};
