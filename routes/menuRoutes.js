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

// GET /menu-items
router.get("/", async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from("menu_items")
      .select("*")
      .eq("restaurant_id", req.restaurantId)
      .order("category")
      .order("name");

    if (error) return res.status(500).json({ message: "Unable to load menu" });
    return res.json(data || []);
  } catch (err) {
    return res.status(500).json({ message: "Unable to load menu" });
  }
});

// POST /menu-items
router.post("/", async (req, res) => {
  try {
    const name = normalizeText(req.body?.name);
    const sellingPrice = toNumber(req.body?.sellingPrice);

    if (!name) return res.status(400).json({ message: "Menu item name is required" });
    if (sellingPrice <= 0)
      return res.status(400).json({ message: "Selling price must be greater than zero" });

    const { data, error } = await req.supabase
      .from("menu_items")
      .insert({
        restaurant_id: req.restaurantId,
        name,
        category: normalizeText(req.body?.category) || "General",
        type: normalizeText(req.body?.type).toUpperCase() === "NON_VEG" ? "NON_VEG" : "VEG",
        selling_price: sellingPrice,
        cost_price: toNumber(req.body?.costPrice),
        gst_percentage: toNumber(req.body?.gstPercentage, 5)
      })
      .select()
      .single();

    if (error) return res.status(500).json({ message: "Unable to create menu item" });
    return res.status(201).json(data);
  } catch (err) {
    return res.status(500).json({ message: "Unable to create menu item" });
  }
});

// PUT /menu-items/:id
router.put("/:id", async (req, res) => {
  try {
    const updates = {};
    if (req.body?.name !== undefined) updates.name = normalizeText(req.body.name);
    if (req.body?.category !== undefined) updates.category = normalizeText(req.body.category);
    if (req.body?.sellingPrice !== undefined) updates.selling_price = toNumber(req.body.sellingPrice);
    if (req.body?.costPrice !== undefined) updates.cost_price = toNumber(req.body.costPrice);
    if (req.body?.isActive !== undefined) updates.is_active = Boolean(req.body.isActive);

    const { data, error } = await req.supabase
      .from("menu_items")
      .update(updates)
      .eq("id", req.params.id)
      .eq("restaurant_id", req.restaurantId)
      .select()
      .single();

    if (error || !data) return res.status(404).json({ message: "Menu item not found" });
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ message: "Unable to update menu item" });
  }
});

// DELETE /menu-items/:id
router.delete("/:id", async (req, res) => {
  try {
    const { error } = await req.supabase
      .from("menu_items")
      .delete()
      .eq("id", req.params.id)
      .eq("restaurant_id", req.restaurantId);

    if (error) return res.status(500).json({ message: "Unable to delete menu item" });
    return res.json({ message: "Menu item deleted" });
  } catch (err) {
    return res.status(500).json({ message: "Unable to delete menu item" });
  }
});

module.exports = router;
