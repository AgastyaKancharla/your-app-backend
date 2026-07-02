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

// GET /ingredients
router.get("/", async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from("ingredients")
      .select("*")
      .eq("restaurant_id", req.restaurantId)
      .order("name");

    if (error) return res.status(500).json({ message: "Unable to load ingredients" });
    return res.json(data || []);
  } catch (err) {
    return res.status(500).json({ message: "Unable to load ingredients" });
  }
});

// GET /ingredients/low-stock
router.get("/low-stock", async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from("ingredients")
      .select("*")
      .eq("restaurant_id", req.restaurantId)
      .eq("low_stock_alert", true);

    if (error) return res.status(500).json({ message: "Unable to load low stock items" });
    return res.json(data || []);
  } catch (err) {
    return res.status(500).json({ message: "Unable to load low stock items" });
  }
});

// POST /ingredients — creates ingredient + records the initial stock-in movement
router.post("/", async (req, res) => {
  try {
    const name = normalizeText(req.body?.name);
    const quantity = Math.max(0, toNumber(req.body?.quantity));

    if (!name) return res.status(400).json({ message: "Ingredient name is required" });

    const payload = {
      restaurant_id: req.restaurantId,
      name,
      quantity: 0, // start at 0, movement below brings it up — keeps the audit trail honest
      unit: normalizeText(req.body?.unit) || "kg",
      min_stock: Math.max(0, toNumber(req.body?.minStock)),
      min_stock_unit: normalizeText(req.body?.minStockUnit) || normalizeText(req.body?.unit) || "kg",
      price_per_unit: Math.max(0, toNumber(req.body?.pricePerUnit)),
      stock_category:
        normalizeText(req.body?.stockCategory).toUpperCase() === "PACKAGING"
          ? "PACKAGING"
          : "RAW_MATERIAL"
    };

    const { data: ingredient, error } = await req.supabase
      .from("ingredients")
      .insert(payload)
      .select()
      .single();

    if (error || !ingredient) return res.status(500).json({ message: "Unable to create ingredient" });

    if (quantity > 0) {
      await req.supabase
        .from("ingredients")
        .update({
          quantity,
          low_stock_alert: quantity <= payload.min_stock
        })
        .eq("id", ingredient.id);

      await req.supabase.from("inventory_movements").insert({
        restaurant_id: req.restaurantId,
        ingredient_id: ingredient.id,
        movement_type: "purchase",
        quantity,
        unit: payload.unit,
        cost_per_unit: payload.price_per_unit,
        stock_before: 0,
        stock_after: quantity,
        reference_type: "adjustment",
        created_by: req.userId,
        notes: "Initial stock"
      });
    }

    const { data: finalIngredient } = await req.supabase
      .from("ingredients")
      .select("*")
      .eq("id", ingredient.id)
      .single();

    return res.status(201).json(finalIngredient || ingredient);
  } catch (err) {
    return res.status(500).json({ message: "Unable to create ingredient" });
  }
});

// POST /ingredients/:id/adjust — manual stock adjustment (+/-)
router.post("/:id/adjust", async (req, res) => {
  try {
    const delta = toNumber(req.body?.quantity);
    if (!delta) return res.status(400).json({ message: "quantity delta is required" });

    const { data: ingredient } = await req.supabase
      .from("ingredients")
      .select("*")
      .eq("id", req.params.id)
      .eq("restaurant_id", req.restaurantId)
      .single();

    if (!ingredient) return res.status(404).json({ message: "Ingredient not found" });

    const stockBefore = toNumber(ingredient.quantity);
    const stockAfter = Math.max(0, stockBefore + delta);

    const { data: updated, error } = await req.supabase
      .from("ingredients")
      .update({
        quantity: stockAfter,
        low_stock_alert: stockAfter <= toNumber(ingredient.min_stock)
      })
      .eq("id", ingredient.id)
      .select()
      .single();

    if (error) return res.status(500).json({ message: "Unable to adjust stock" });

    await req.supabase.from("inventory_movements").insert({
      restaurant_id: req.restaurantId,
      ingredient_id: ingredient.id,
      movement_type: "adjustment",
      quantity: delta,
      unit: ingredient.unit,
      cost_per_unit: ingredient.price_per_unit,
      stock_before: stockBefore,
      stock_after: stockAfter,
      reference_type: "adjustment",
      created_by: req.userId,
      notes: normalizeText(req.body?.reason) || "Manual adjustment"
    });

    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ message: "Unable to adjust stock" });
  }
});

// DELETE /ingredients/:id
router.delete("/:id", async (req, res) => {
  try {
    const { error } = await req.supabase
      .from("ingredients")
      .delete()
      .eq("id", req.params.id)
      .eq("restaurant_id", req.restaurantId);

    if (error) return res.status(500).json({ message: "Unable to delete ingredient" });
    return res.json({ message: "Ingredient deleted" });
  } catch (err) {
    return res.status(500).json({ message: "Unable to delete ingredient" });
  }
});

module.exports = router;
