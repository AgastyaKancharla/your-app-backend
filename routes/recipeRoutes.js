const express = require("express");
const { requireAuth } = require("../middleware/requireAuth");
const { requireTenant } = require("../middleware/requireTenant");

const router = express.Router();

router.use(requireAuth, requireTenant);

const normalizeText = (v = "") => String(v || "").trim();
const toNumber = (v, f = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : f;
};

// GET /recipes
router.get("/", async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from("recipes")
      .select("*")
      .eq("restaurant_id", req.restaurantId)
      .order("menu_item_name");

    if (error) return res.status(500).json({ message: "Unable to load recipes" });
    return res.json(data || []);
  } catch (err) {
    return res.status(500).json({ message: "Unable to load recipes" });
  }
});

// POST /recipes — create or replace the recipe for a menu item
router.post("/", async (req, res) => {
  try {
    const menuItemId = normalizeText(req.body?.menuItemId);
    const ingredients = Array.isArray(req.body?.ingredients) ? req.body.ingredients : [];

    if (!menuItemId) return res.status(400).json({ message: "menuItemId is required" });
    if (!ingredients.length) {
      return res.status(400).json({ message: "At least one ingredient is required" });
    }

    const cleanIngredients = ingredients
      .filter((i) => i?.ingredientId && toNumber(i?.quantity) > 0)
      .map((i) => ({
        ingredient_id: i.ingredientId,
        ingredient_name: normalizeText(i.ingredientName),
        quantity: toNumber(i.quantity),
        unit: normalizeText(i.unit) || "kg"
      }));

    if (!cleanIngredients.length) {
      return res.status(400).json({ message: "Ingredients list is invalid" });
    }

    // Verify the menu item belongs to this restaurant before linking
    const { data: menuItem } = await req.supabase
      .from("menu_items")
      .select("id, name")
      .eq("id", menuItemId)
      .eq("restaurant_id", req.restaurantId)
      .single();

    if (!menuItem) return res.status(404).json({ message: "Menu item not found" });

    const { data: existing } = await req.supabase
      .from("recipes")
      .select("id")
      .eq("restaurant_id", req.restaurantId)
      .eq("menu_item_id", menuItemId)
      .maybeSingle();

    let recipe;
    if (existing) {
      const { data: updated, error } = await req.supabase
        .from("recipes")
        .update({
          menu_item_name: menuItem.name,
          pack_name: normalizeText(req.body?.packName) || "Pack",
          ingredients: cleanIngredients
        })
        .eq("id", existing.id)
        .select()
        .single();
      if (error) return res.status(500).json({ message: "Unable to update recipe" });
      recipe = updated;
    } else {
      const { data: created, error } = await req.supabase
        .from("recipes")
        .insert({
          restaurant_id: req.restaurantId,
          menu_item_id: menuItemId,
          menu_item_name: menuItem.name,
          pack_name: normalizeText(req.body?.packName) || "Pack",
          ingredients: cleanIngredients
        })
        .select()
        .single();
      if (error) return res.status(500).json({ message: "Unable to create recipe" });
      recipe = created;
    }

    // Link menu_items.recipe_id back to this recipe
    await req.supabase.from("menu_items").update({ recipe_id: recipe.id }).eq("id", menuItemId);

    return res.status(existing ? 200 : 201).json(recipe);
  } catch (err) {
    return res.status(500).json({ message: "Unable to save recipe" });
  }
});

// DELETE /recipes/:id
router.delete("/:id", async (req, res) => {
  try {
    const { error } = await req.supabase
      .from("recipes")
      .delete()
      .eq("id", req.params.id)
      .eq("restaurant_id", req.restaurantId);

    if (error) return res.status(500).json({ message: "Unable to delete recipe" });
    return res.json({ message: "Recipe deleted" });
  } catch (err) {
    return res.status(500).json({ message: "Unable to delete recipe" });
  }
});

module.exports = router;
