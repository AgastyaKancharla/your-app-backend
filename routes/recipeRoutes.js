const express = require("express");
const Recipe = require("../models/Recipe");
const MenuItem = require("../models/MenuItem");
const authorizeRoles = require("../middleware/authorizeRoles");
const { requirePlanFeature } = require("../middleware/planLimitMiddleware");
const { syncMenuAvailability } = require("../services/cloudKitchenOperationsService");
const { getQuantityPerPack } = require("../utils/recipeQuantities");
const { RECIPE_MANAGEMENT_ROLES } = require("../utils/accessControl");
const { getCloudKitchenWorkspaceIfAvailable } = require("../utils/cloudKitchenWorkspace");
const {
  getTenantRestaurantId,
  withTenantFilter,
  withTenantDocFilter
} = require("../utils/tenantScope");

const router = express.Router();

router.use(
  requirePlanFeature("recipeCosting", {
    requiredPlan: "GROWTH",
    message: "Recipe costing is available on GROWTH and above plans."
  })
);

const escapeRegex = (value = "") => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const maybeSyncCloudKitchenAvailability = async (req, menuItemId = null) => {
  const workspace = await getCloudKitchenWorkspaceIfAvailable(req);
  if (!workspace?._id) {
    return [];
  }

  return syncMenuAvailability(workspace._id, {
    menuItemIds: menuItemId ? [menuItemId] : undefined
  });
};

router.get("/", authorizeRoles(RECIPE_MANAGEMENT_ROLES), async (req, res) => {
  try {
    const recipes = await Recipe.find(withTenantFilter(req)).sort({ menuItem: 1 });
    res.json(recipes);
  } catch (err) {
    return res.serverError(err);
  }
});

router.post("/", authorizeRoles(RECIPE_MANAGEMENT_ROLES), async (req, res) => {
  try {
    const restaurantId = getTenantRestaurantId(req);
    const { menuItem, ingredients = [] } = req.body;
    const packName = String(req.body?.packName || "Pack").trim() || "Pack";

    if (!menuItem || !ingredients.length) {
      return res
        .status(400)
        .json({ message: "menuItem and at least one ingredient are required" });
    }

    const cleanIngredients = ingredients
      .filter((ing) => {
        const qtyPerPack = getQuantityPerPack(ing);
        return ing.ingredientName && qtyPerPack > 0;
      })
      .map((ing) => {
        const qtyPerPack = getQuantityPerPack(ing);
        return {
          itemId: ing.itemId || ing.inventoryId || null,
          inventoryId: ing.inventoryId || ing.itemId || null,
          ingredientName: ing.ingredientName,
          quantity: qtyPerPack,
          quantityRequired: qtyPerPack,
          quantityPerPack: qtyPerPack,
          unit: ing.unit || "kg"
        };
      });

    if (!cleanIngredients.length) {
      return res.status(400).json({ message: "Invalid ingredients list" });
    }

    const trimmedMenuItem = menuItem.trim();
    const menuItemId = req.body?.menuItemId || null;

    const existing = await Recipe.findOne(
      withTenantFilter(req, {
        menuItem: {
          $regex: new RegExp(`^${escapeRegex(trimmedMenuItem)}$`, "i")
        }
      })
    );

    if (existing) {
      existing.ingredients = cleanIngredients;
      existing.menuItem = trimmedMenuItem;
      existing.menuItemId = menuItemId || existing.menuItemId || null;
      existing.packName = packName;
      await existing.save();
      if (existing.menuItemId) {
        await MenuItem.findOneAndUpdate(
          withTenantDocFilter(req, existing.menuItemId),
          { recipeId: existing._id, recipeLink: String(existing._id) }
        );
      }
      await maybeSyncCloudKitchenAvailability(req, existing.menuItemId);
      return res.json(existing);
    }

    const recipe = await Recipe.create({
      restaurantId,
      menuItemId,
      menuItem: trimmedMenuItem,
      packName,
      ingredients: cleanIngredients
    });

    if (menuItemId) {
      await MenuItem.findOneAndUpdate(
        withTenantDocFilter(req, menuItemId),
        { recipeId: recipe._id, recipeLink: String(recipe._id) }
      );
    }

    await maybeSyncCloudKitchenAvailability(req, menuItemId);
    res.status(201).json(recipe);
  } catch (err) {
    return res.serverError(err);
  }
});

router.put("/:id", authorizeRoles(RECIPE_MANAGEMENT_ROLES), async (req, res) => {
  try {
    const { menuItem, ingredients = [] } = req.body;
    const packName = String(req.body?.packName || "Pack").trim() || "Pack";

    const cleanIngredients = ingredients
      .filter((ing) => {
        const qtyPerPack = getQuantityPerPack(ing);
        return ing.ingredientName && qtyPerPack > 0;
      })
      .map((ing) => {
        const qtyPerPack = getQuantityPerPack(ing);
        return {
          itemId: ing.itemId || ing.inventoryId || null,
          inventoryId: ing.inventoryId || ing.itemId || null,
          ingredientName: ing.ingredientName,
          quantity: qtyPerPack,
          quantityRequired: qtyPerPack,
          quantityPerPack: qtyPerPack,
          unit: ing.unit || "kg"
        };
      });

    const menuItemId = req.body?.menuItemId || null;
    const updated = await Recipe.findOneAndUpdate(
      withTenantDocFilter(req, req.params.id),
      {
        menuItemId,
        packName,
        menuItem: menuItem?.trim(),
        ingredients: cleanIngredients
      },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ message: "Recipe not found" });
    }

    if (menuItemId) {
      await MenuItem.findOneAndUpdate(
        withTenantDocFilter(req, menuItemId),
        { recipeId: updated._id, recipeLink: String(updated._id) }
      );
    }

    await maybeSyncCloudKitchenAvailability(req, menuItemId || updated.menuItemId);
    res.json(updated);
  } catch (err) {
    return res.serverError(err);
  }
});

router.delete("/:id", authorizeRoles(RECIPE_MANAGEMENT_ROLES), async (req, res) => {
  try {
    const deleted = await Recipe.findOneAndDelete(withTenantDocFilter(req, req.params.id));

    if (!deleted) {
      return res.status(404).json({ message: "Recipe not found" });
    }

    await maybeSyncCloudKitchenAvailability(req, deleted.menuItemId);
    res.json({ message: "Recipe deleted" });
  } catch (err) {
    return res.serverError(err);
  }
});

module.exports = router;
