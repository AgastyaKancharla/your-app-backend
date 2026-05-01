const Ingredient = require("../models/Ingredient");
const MenuItem = require("../models/MenuItem");
const Order = require("../models/Order");
const Recipe = require("../models/Recipe");
const {
  isCompletedOrderStatus,
  normalizeOrderStatus
} = require("../utils/accessControl");
const { calculateIngredientDeduction, getQuantityPerPack } = require("../utils/recipeQuantities");
const { isBelowMinStock } = require("../utils/unitConversion");

const DEFAULT_EXPECTED_PREP_TIME_MINUTES = 18;

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeName = (value = "") => String(value || "").trim().toLowerCase();

const escapeRegex = (value = "") => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getIngredientLookup = (ingredients = []) => {
  const byId = new Map();
  const byName = new Map();

  ingredients.forEach((ingredient) => {
    if (ingredient?._id) {
      byId.set(String(ingredient._id), ingredient);
    }

    const normalized = normalizeName(ingredient?.name || ingredient?.itemName);
    if (normalized) {
      byName.set(normalized, ingredient);
    }
  });

  return { byId, byName };
};

const findIngredientForRecipeLine = (lookup, ingredientLine = {}) => {
  const itemId = ingredientLine.itemId || ingredientLine.inventoryId || null;
  if (itemId && lookup.byId.has(String(itemId))) {
    return lookup.byId.get(String(itemId));
  }

  const normalized = normalizeName(ingredientLine.ingredientName);
  if (normalized && lookup.byName.has(normalized)) {
    return lookup.byName.get(normalized);
  }

  return null;
};

const getRecipeLookup = (recipes = []) => {
  const byMenuId = new Map();
  const byName = new Map();

  recipes.forEach((recipe) => {
    if (recipe?.menuItemId) {
      byMenuId.set(String(recipe.menuItemId), recipe);
    }

    const normalized = normalizeName(recipe?.menuItem);
    if (normalized) {
      byName.set(normalized, recipe);
    }
  });

  return { byMenuId, byName };
};

const findRecipeForMenuItem = (lookup, menuItem = {}) => {
  if (menuItem?._id && lookup.byMenuId.has(String(menuItem._id))) {
    return lookup.byMenuId.get(String(menuItem._id));
  }

  const normalized = normalizeName(menuItem?.name);
  if (normalized && lookup.byName.has(normalized)) {
    return lookup.byName.get(normalized);
  }

  return null;
};

const findRecipeForOrderedItem = (lookup, orderItem = {}) => {
  const menuItemId = orderItem.menuItemId || orderItem.menuId || null;
  if (menuItemId && lookup.byMenuId.has(String(menuItemId))) {
    return lookup.byMenuId.get(String(menuItemId));
  }

  const normalizedCandidates = [
    normalizeName(orderItem.name),
    normalizeName(orderItem.displayName).replace(/\s*\(.*\)\s*$/, "")
  ].filter(Boolean);

  for (const candidate of normalizedCandidates) {
    if (lookup.byName.has(candidate)) {
      return lookup.byName.get(candidate);
    }
  }

  return null;
};

const applyLowStockFlags = async (ingredients = []) => {
  if (!ingredients.length) {
    return;
  }

  await Ingredient.bulkWrite(
    ingredients.map((ingredient) => ({
      updateOne: {
        filter: { _id: ingredient._id },
        update: {
          $set: {
            lowStockAlert: isBelowMinStock({
              quantity: ingredient.quantity,
              unit: ingredient.unit,
              minStock: ingredient.minStock,
              minStockUnit: ingredient.minStockUnit
            }),
            stock: ingredient.quantity,
            currentStock: ingredient.quantity,
            threshold: ingredient.minStock,
            itemName: ingredient.name
          }
        }
      }
    })),
    { ordered: false }
  );
};

const calculateAvailabilityFromRecipe = ({ menuItem, recipe, ingredientLookup }) => {
  if (menuItem?.isActive === false) {
    return "OUT_OF_STOCK";
  }

  if (!recipe || !Array.isArray(recipe.ingredients) || recipe.ingredients.length === 0) {
    const normalizedAvailability = String(menuItem?.availability || "").trim().toUpperCase();
    if (["IN_STOCK", "LOW_STOCK", "OUT_OF_STOCK"].includes(normalizedAvailability)) {
      return normalizedAvailability;
    }
    return menuItem?.isAvailable === false ? "OUT_OF_STOCK" : "IN_STOCK";
  }

  let hasLowStock = false;

  for (const ingredientLine of recipe.ingredients) {
    const ingredient = findIngredientForRecipeLine(ingredientLookup, ingredientLine);
    if (!ingredient) {
      return "OUT_OF_STOCK";
    }

    const quantity = toNumber(ingredient.quantity);
    const neededPerOrder = getQuantityPerPack(ingredientLine);
    const possibleServings = neededPerOrder > 0 ? Math.floor(quantity / neededPerOrder) : 0;

    if (quantity <= 0 || possibleServings <= 0) {
      return "OUT_OF_STOCK";
    }

    if (
      ingredient.lowStockAlert ||
      possibleServings <= 3 ||
      isBelowMinStock({
        quantity,
        unit: ingredient.unit,
        minStock: ingredient.minStock,
        minStockUnit: ingredient.minStockUnit
      })
    ) {
      hasLowStock = true;
    }
  }

  return hasLowStock ? "LOW_STOCK" : "IN_STOCK";
};

const syncMenuAvailability = async (restaurantId, options = {}) => {
  const menuFilter = { restaurantId };
  if (Array.isArray(options.menuItemIds) && options.menuItemIds.length) {
    menuFilter._id = { $in: options.menuItemIds };
  }

  const [menuItems, recipes, ingredients] = await Promise.all([
    MenuItem.find(menuFilter),
    Recipe.find({ restaurantId }),
    Ingredient.find({ restaurantId })
  ]);

  if (!menuItems.length) {
    return [];
  }

  const recipeLookup = getRecipeLookup(recipes);
  const ingredientLookup = getIngredientLookup(ingredients);
  const operations = [];
  const nextItems = [];

  menuItems.forEach((menuItem) => {
    const recipe = findRecipeForMenuItem(recipeLookup, menuItem);
    const availability = calculateAvailabilityFromRecipe({
      menuItem,
      recipe,
      ingredientLookup
    });
    const isAvailable = menuItem.isActive !== false && availability !== "OUT_OF_STOCK";

    nextItems.push({
      ...menuItem.toObject(),
      availability,
      isAvailable
    });

    if (availability !== menuItem.availability || isAvailable !== menuItem.isAvailable) {
      operations.push({
        updateOne: {
          filter: { _id: menuItem._id },
          update: {
            $set: {
              availability,
              isAvailable
            }
          }
        }
      });
    }
  });

  if (operations.length) {
    await MenuItem.bulkWrite(operations, { ordered: false });
  }

  return nextItems;
};

const collectInventoryRequirements = async ({ restaurantId, orderItems = [] }) => {
  const recipes = await Recipe.find({ restaurantId });
  const ingredients = await Ingredient.find({ restaurantId });
  const recipeLookup = getRecipeLookup(recipes);
  const ingredientLookup = getIngredientLookup(ingredients);
  const requiredByIngredientId = new Map();
  const affectedMenuIds = new Set();

  for (const item of orderItems) {
    const recipe = findRecipeForOrderedItem(recipeLookup, item);
    if (!recipe) {
      // Cloud kitchen POS should remain operational even when recipe
      // mappings are still being configured for newer menu items.
      continue;
    }

    if (recipe.menuItemId) {
      affectedMenuIds.add(String(recipe.menuItemId));
    }

    for (const ingredientLine of recipe.ingredients || []) {
      const ingredient = findIngredientForRecipeLine(ingredientLookup, ingredientLine);
      if (!ingredient) {
        continue;
      }

      const deductionQty = calculateIngredientDeduction(ingredientLine, item.quantity);
      if (!deductionQty) {
        continue;
      }

      const key = String(ingredient._id);
      const current = requiredByIngredientId.get(key) || {
        ingredient,
        required: 0
      };
      current.required += deductionQty;
      requiredByIngredientId.set(key, current);
    }
  }

  return {
    requirements: Array.from(requiredByIngredientId.values()),
    affectedMenuIds: Array.from(affectedMenuIds)
  };
};

const assertInventoryAvailableForItems = async ({ restaurantId, orderItems = [] }) => {
  const { requirements } = await collectInventoryRequirements({ restaurantId, orderItems });

  requirements.forEach(({ ingredient, required }) => {
    const available = toNumber(ingredient.quantity);
    if (available < required) {
      const error = new Error(
        `Insufficient stock for ${ingredient.name}. Required ${required}, available ${available}.`
      );
      error.status = 409;
      throw error;
    }
  });

  return requirements;
};

const deductInventoryForItems = async ({ restaurantId, orderItems = [] }) => {
  const { requirements, affectedMenuIds } = await collectInventoryRequirements({
    restaurantId,
    orderItems
  });

  if (!requirements.length) {
    await syncMenuAvailability(restaurantId, {
      menuItemIds: affectedMenuIds
    });

    return {
      deducted: [],
      menuItems: []
    };
  }

  requirements.forEach(({ ingredient, required }) => {
    const available = toNumber(ingredient.quantity);
    if (available < required) {
      const error = new Error(
        `Insufficient stock for ${ingredient.name}. Required ${required}, available ${available}.`
      );
      error.status = 409;
      throw error;
    }
  });

  await Ingredient.bulkWrite(
    requirements.map(({ ingredient, required }) => ({
      updateOne: {
        filter: { _id: ingredient._id, restaurantId },
        update: {
          $inc: {
            quantity: -required,
            currentStock: -required,
            stock: -required
          },
          $set: {
            itemName: ingredient.name,
            threshold: ingredient.minStock
          }
        }
      }
    })),
    { ordered: false }
  );

  const updatedIngredients = await Ingredient.find({
    restaurantId,
    _id: { $in: requirements.map(({ ingredient }) => ingredient._id) }
  });
  await applyLowStockFlags(updatedIngredients);
  const menuItems = await syncMenuAvailability(restaurantId, {
    menuItemIds: affectedMenuIds
  });

  return {
    deducted: updatedIngredients.map((ingredient) => ({
      itemId: ingredient._id,
      itemName: ingredient.name,
      stock: ingredient.quantity,
      unit: ingredient.unit,
      threshold: ingredient.minStock,
      lowStockAlert: Boolean(ingredient.lowStockAlert)
    })),
    menuItems
  };
};

const getExpectedPrepTimeMinutesForItems = (menuItems = [], orderItems = []) => {
  const menuById = new Map();
  const menuByName = new Map();

  menuItems.forEach((menuItem) => {
    if (menuItem?._id) {
      menuById.set(String(menuItem._id), menuItem);
    }

    const normalized = normalizeName(menuItem?.name);
    if (normalized) {
      menuByName.set(normalized, menuItem);
    }
  });

  const prepTimes = orderItems
    .map((item) => {
      const key = String(item.menuItemId || item.menuId || "");
      const byId = key ? menuById.get(key) : null;
      const byName = menuByName.get(normalizeName(item.name));
      return toNumber(
        byId?.expectedPrepTimeMinutes ??
          byName?.expectedPrepTimeMinutes ??
          item.expectedPrepTimeMinutes,
        0
      );
    })
    .filter((value) => value > 0);

  return prepTimes.length
    ? Math.max(...prepTimes)
    : DEFAULT_EXPECTED_PREP_TIME_MINUTES;
};

const getOrderAgeMinutes = (order, now = Date.now()) => {
  const createdAt = new Date(order?.createdAt || now).getTime();
  if (!Number.isFinite(createdAt)) {
    return 0;
  }

  return Math.max(0, (now - createdAt) / 60000);
};

const resolveCompletionTime = (order = {}) =>
  order.completedAt || order.readyAt || order.delivery?.deliveredAt || null;

const getOperationalMetrics = async ({ restaurantId, now = Date.now() }) => {
  const [activeOrders, completedOrders] = await Promise.all([
    Order.find({
      restaurantId,
      status: {
        $nin: ["DELIVERED", "DISPATCHED", "COMPLETED", "DONE", "CANCELLED"]
      }
    }).lean(),
    Order.find({
      restaurantId,
      status: {
        $in: ["READY", "DELIVERED", "DISPATCHED", "COMPLETED", "DONE"]
      }
    })
      .sort({ createdAt: -1 })
      .limit(150)
      .lean()
  ]);

  const delayedOrders = activeOrders.filter((order) => {
    const expected = Math.max(
      1,
      toNumber(order.expectedPrepTimeMinutes, DEFAULT_EXPECTED_PREP_TIME_MINUTES)
    );
    return getOrderAgeMinutes(order, now) > expected;
  }).length;

  const completedPrepTimes = completedOrders
    .map((order) => {
      const completedAt = resolveCompletionTime(order);
      if (!completedAt) {
        return 0;
      }

      return Math.max(
        0,
        (new Date(completedAt).getTime() - new Date(order.createdAt || now).getTime()) / 60000
      );
    })
    .filter((value) => value > 0);

  const avgPrepTime =
    completedPrepTimes.length > 0
      ? Number(
          (
            completedPrepTimes.reduce((sum, value) => sum + value, 0) / completedPrepTimes.length
          ).toFixed(1)
        )
      : 0;

  return {
    activeOrders: activeOrders.length,
    delayedOrders,
    avgPrepTime
  };
};

const getAlerts = async ({ restaurantId, now = Date.now() }) => {
  const [ingredients, orders] = await Promise.all([
    Ingredient.find({ restaurantId, lowStockAlert: true }).sort({ quantity: 1 }).lean(),
    Order.find({
      restaurantId,
      status: {
        $nin: ["DELIVERED", "DISPATCHED", "COMPLETED", "DONE", "CANCELLED"]
      }
    })
      .sort({ createdAt: 1 })
      .lean()
  ]);

  const lowStockAlerts = ingredients.map((ingredient) => ({
    id: `stock-${ingredient._id}`,
    type: "LOW_STOCK",
    severity: toNumber(ingredient.quantity) <= 0 ? "high" : "medium",
    itemId: ingredient._id,
    itemName: ingredient.name,
    stock: toNumber(ingredient.quantity),
    threshold: toNumber(ingredient.minStock),
    unit: ingredient.unit || "pcs",
    message: `${ingredient.name} is running low`
  }));

  const delayAlerts = orders
    .filter((order) => {
      const expected = Math.max(
        1,
        toNumber(order.expectedPrepTimeMinutes, DEFAULT_EXPECTED_PREP_TIME_MINUTES)
      );
      return getOrderAgeMinutes(order, now) > expected;
    })
    .map((order) => ({
      id: `delay-${order._id}`,
      type: "ORDER_DELAY",
      severity: "high",
      orderId: order._id,
      status: normalizeOrderStatus(order.status, "NEW"),
      expectedPrepTimeMinutes: toNumber(
        order.expectedPrepTimeMinutes,
        DEFAULT_EXPECTED_PREP_TIME_MINUTES
      ),
      ageMinutes: Number(getOrderAgeMinutes(order, now).toFixed(1)),
      message: `Order #${String(order.invoiceNumber || order._id).slice(-6).toUpperCase()} is delayed`
    }));

  return {
    alerts: [...delayAlerts, ...lowStockAlerts],
    lowStockAlerts,
    delayAlerts
  };
};

module.exports = {
  DEFAULT_EXPECTED_PREP_TIME_MINUTES,
  assertInventoryAvailableForItems,
  deductInventoryForItems,
  escapeRegex,
  getAlerts,
  getExpectedPrepTimeMinutesForItems,
  getOperationalMetrics,
  syncMenuAvailability
};
