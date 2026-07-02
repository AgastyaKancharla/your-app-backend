const express = require("express");
const { requireAuth } = require("../middleware/requireAuth");
const { requireTenant } = require("../middleware/requireTenant");

const router = express.Router();

router.use(requireAuth, requireTenant);

const toNumber = (v, f = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : f;
};
const normalizeText = (v = "") => String(v || "").trim();
const normalizePhone = (v = "") => String(v || "").replace(/[^\d+]/g, "").trim();

/**
 * POST /orders
 *
 * Creates an order. Inventory deduction only happens if the restaurant
 * has inventory_deduction_enabled = true — this is the core product
 * decision from the start of this project: a coffee shop should be able
 * to sell immediately without setting up recipes first. Businesses that
 * want stock tracking opt in via PATCH /restaurants/current/features.
 */
router.post("/", async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) {
      return res.status(400).json({ message: "Order must contain at least one item" });
    }

    const cleanItems = items
      .filter((i) => normalizeText(i?.name) && toNumber(i?.quantity) > 0)
      .map((i) => ({
        menu_item_id: i.menuItemId || null,
        name: normalizeText(i.name),
        quantity: toNumber(i.quantity),
        price: toNumber(i.price),
        gst_percentage: toNumber(i.gstPercentage, 5)
      }));

    if (!cleanItems.length) {
      return res.status(400).json({ message: "Order items are invalid" });
    }

    const subtotal = cleanItems.reduce((s, i) => s + i.quantity * i.price, 0);
    const gstTotal = cleanItems.reduce(
      (s, i) => s + i.quantity * i.price * (i.gst_percentage / 100),
      0
    );
    const discount = Math.max(0, toNumber(req.body?.discount));
    const grandTotal = Math.max(0, subtotal + gstTotal - discount);

    const customerPhone = normalizePhone(req.body?.customerPhone);
    const customerName = normalizeText(req.body?.customerName);

    // Restaurant lookup — RLS-scoped, so this only succeeds if the user
    // is genuinely a member of req.restaurantId (already verified by
    // requireTenant, but we need the actual flag values here).
    const { data: restaurant, error: restaurantError } = await req.supabase
      .from("restaurants")
      .select("has_delivery, has_tables, inventory_deduction_enabled")
      .eq("id", req.restaurantId)
      .single();

    if (restaurantError || !restaurant) {
      return res.status(404).json({ message: "Restaurant not found" });
    }

    const initialStatus = restaurant.has_delivery && !restaurant.has_tables ? "NEW" : "PREPARING";

    const { data: order, error: orderError } = await req.supabase
      .from("orders")
      .insert({
        restaurant_id: req.restaurantId,
        items: cleanItems,
        subtotal,
        gst_total: gstTotal,
        discount,
        grand_total: grandTotal,
        payment_mode: normalizeText(req.body?.paymentMode).toUpperCase() || "CASH",
        service_type: normalizeText(req.body?.serviceType).toUpperCase() || "DINE_IN",
        table_code: normalizeText(req.body?.tableCode),
        customer_name: customerName,
        customer_phone: customerPhone,
        status: initialStatus,
        status_timeline: [{ status: initialStatus, changedAt: new Date().toISOString() }],
        created_by: req.userId
      })
      .select()
      .single();

    if (orderError || !order) {
      return res.status(500).json({ message: "Unable to create order" });
    }

    // Inventory deduction — ONLY if the restaurant opted in.
    if (restaurant.inventory_deduction_enabled) {
      await deductInventoryForOrder(req.supabase, req.restaurantId, cleanItems, order.id, req.userId);
    }

    // Customer upsert — only if a phone was provided.
    if (customerPhone) {
      await upsertCustomerForOrder(req.supabase, req.restaurantId, {
        phone: customerPhone,
        name: customerName,
        grandTotal,
        orderId: order.id
      });
    }

    return res.status(201).json(order);
  } catch (err) {
    return res.status(500).json({ message: "Unable to create order" });
  }
});

/**
 * deductInventoryForOrder
 * Looks up a recipe for each ordered menu item. If no recipe exists,
 * that item is silently skipped — this is what lets a business sell
 * items they haven't mapped to ingredients yet, even with the flag on.
 */
async function deductInventoryForOrder(supabase, restaurantId, items, orderId, userId) {
  for (const item of items) {
    if (!item.menu_item_id) continue;

    const { data: recipe } = await supabase
      .from("recipes")
      .select("ingredients")
      .eq("restaurant_id", restaurantId)
      .eq("menu_item_id", item.menu_item_id)
      .maybeSingle();

    if (!recipe || !Array.isArray(recipe.ingredients)) continue;

    for (const line of recipe.ingredients) {
      const ingredientId = line?.ingredient_id;
      const qtyPerUnit = toNumber(line?.quantity);
      if (!ingredientId || qtyPerUnit <= 0) continue;

      const deductQty = qtyPerUnit * item.quantity;

      const { data: ingredient } = await supabase
        .from("ingredients")
        .select("quantity, unit, price_per_unit, min_stock")
        .eq("id", ingredientId)
        .eq("restaurant_id", restaurantId)
        .maybeSingle();

      if (!ingredient) continue;

      const stockBefore = toNumber(ingredient.quantity);
      const stockAfter = Math.max(0, stockBefore - deductQty);

      await supabase
        .from("ingredients")
        .update({
          quantity: stockAfter,
          low_stock_alert: stockAfter <= toNumber(ingredient.min_stock)
        })
        .eq("id", ingredientId);

      await supabase.from("inventory_movements").insert({
        restaurant_id: restaurantId,
        ingredient_id: ingredientId,
        movement_type: "order_deduction",
        quantity: -deductQty,
        unit: ingredient.unit,
        cost_per_unit: ingredient.price_per_unit,
        stock_before: stockBefore,
        stock_after: stockAfter,
        reference_type: "order",
        reference_id: orderId,
        created_by: userId
      });
    }
  }
}

async function upsertCustomerForOrder(supabase, restaurantId, { phone, name, grandTotal, orderId }) {
  const { data: existing } = await supabase
    .from("customers")
    .select("id, order_count, lifetime_value")
    .eq("restaurant_id", restaurantId)
    .eq("phone", phone)
    .maybeSingle();

  if (existing) {
    await supabase
      .from("customers")
      .update({
        name: name || undefined,
        order_count: toNumber(existing.order_count) + 1,
        lifetime_value: toNumber(existing.lifetime_value) + grandTotal,
        last_order_at: new Date().toISOString()
      })
      .eq("id", existing.id);
  } else {
    await supabase.from("customers").insert({
      restaurant_id: restaurantId,
      phone,
      name,
      order_count: 1,
      lifetime_value: grandTotal,
      first_order_at: new Date().toISOString(),
      last_order_at: new Date().toISOString()
    });
  }
}

// GET /orders
router.get("/", async (req, res) => {
  try {
    let query = req.supabase
      .from("orders")
      .select("*")
      .eq("restaurant_id", req.restaurantId)
      .order("created_at", { ascending: false })
      .limit(200);

    const status = normalizeText(req.query?.status).toUpperCase();
    if (status && status !== "ALL") query = query.eq("status", status);

    const { data, error } = await query;
    if (error) return res.status(500).json({ message: "Unable to load orders" });
    return res.json(data || []);
  } catch (err) {
    return res.status(500).json({ message: "Unable to load orders" });
  }
});

// GET /orders/:id
router.get("/:id", async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from("orders")
      .select("*")
      .eq("id", req.params.id)
      .eq("restaurant_id", req.restaurantId)
      .single();

    if (error || !data) return res.status(404).json({ message: "Order not found" });
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ message: "Unable to load order" });
  }
});

// PATCH /orders/:id/status
router.patch("/:id/status", async (req, res) => {
  try {
    const nextStatus = normalizeText(req.body?.status).toUpperCase();
    const validStatuses = ["NEW", "PREPARING", "READY", "DISPATCHED", "DELIVERED", "CANCELLED"];
    if (!validStatuses.includes(nextStatus)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const { data: order } = await req.supabase
      .from("orders")
      .select("status_timeline")
      .eq("id", req.params.id)
      .eq("restaurant_id", req.restaurantId)
      .single();

    if (!order) return res.status(404).json({ message: "Order not found" });

    const timeline = Array.isArray(order.status_timeline) ? order.status_timeline : [];
    timeline.push({ status: nextStatus, changedAt: new Date().toISOString() });

    const patch = { status: nextStatus, status_timeline: timeline };
    if (nextStatus === "READY") patch.ready_at = new Date().toISOString();
    if (nextStatus === "DISPATCHED") patch.dispatched_at = new Date().toISOString();
    if (nextStatus === "DELIVERED") patch.completed_at = new Date().toISOString();
    if (nextStatus === "CANCELLED") patch.cancelled_at = new Date().toISOString();

    const { data: updated, error } = await req.supabase
      .from("orders")
      .update(patch)
      .eq("id", req.params.id)
      .eq("restaurant_id", req.restaurantId)
      .select()
      .single();

    if (error || !updated) return res.status(500).json({ message: "Unable to update order" });
    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ message: "Unable to update order" });
  }
});

module.exports = router;
