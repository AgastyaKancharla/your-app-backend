const express = require("express");
const { requireAuth } = require("../middleware/requireAuth");
const { requireTenant } = require("../middleware/requireTenant");

const router = express.Router();

const normalizeText = (v = "") => String(v || "").trim();

// The 12 cards from onboarding Screen 2, mapped to their default flags.
// This map lives in exactly one place — if we add a 13th business type
// later, this is the only place that needs updating.
const BUSINESS_TYPE_DEFAULTS = {
  CAFE: { hasTables: true, hasDelivery: false, hasMultipleOutlets: false },
  RESTAURANT: { hasTables: true, hasDelivery: false, hasMultipleOutlets: false },
  FINE_DINING: { hasTables: true, hasDelivery: false, hasMultipleOutlets: false },
  CLOUD_KITCHEN: { hasTables: false, hasDelivery: true, hasMultipleOutlets: false },
  QSR: { hasTables: false, hasDelivery: true, hasMultipleOutlets: false },
  CHAI_STALL: { hasTables: false, hasDelivery: false, hasMultipleOutlets: false },
  BAKERY: { hasTables: false, hasDelivery: false, hasMultipleOutlets: false },
  FOOD_TRUCK: { hasTables: false, hasDelivery: false, hasMultipleOutlets: false },
  DHABA: { hasTables: true, hasDelivery: false, hasMultipleOutlets: false },
  TIFFIN_SERVICE: { hasTables: false, hasDelivery: true, hasMultipleOutlets: false },
  CATERING: { hasTables: false, hasDelivery: true, hasMultipleOutlets: false },
  CANTEEN: { hasTables: true, hasDelivery: false, hasMultipleOutlets: false },
  UNSET: { hasTables: false, hasDelivery: false, hasMultipleOutlets: false }
};

/**
 * POST /restaurants
 * Screen 2+3 of onboarding: pick a business type card (sets defaults),
 * optionally override the flags, provide name + city.
 *
 * Runs as the logged-in user via req.supabase — RLS's
 * restaurants_insert_authenticated policy allows any authenticated user
 * to insert. The database trigger (handle_new_restaurant) then
 * auto-creates the first outlet and the owner membership — so there is
 * no app-code path that could forget to do either.
 */
router.post("/", requireAuth, async (req, res) => {
  try {
    const name = normalizeText(req.body?.name);
    const city = normalizeText(req.body?.city);
    const businessTypeLabel = normalizeText(req.body?.businessTypeLabel).toUpperCase() || "UNSET";

    if (!name) {
      return res.status(400).json({ message: "Restaurant name is required" });
    }

    const defaults = BUSINESS_TYPE_DEFAULTS[businessTypeLabel] || BUSINESS_TYPE_DEFAULTS.UNSET;
    const overrides = req.body?.businessFeatures || {};

    const businessFeatures = {
      has_tables:
        overrides.hasTables !== undefined ? Boolean(overrides.hasTables) : defaults.hasTables,
      has_delivery:
        overrides.hasDelivery !== undefined ? Boolean(overrides.hasDelivery) : defaults.hasDelivery,
      has_multiple_outlets:
        overrides.hasMultipleOutlets !== undefined
          ? Boolean(overrides.hasMultipleOutlets)
          : defaults.hasMultipleOutlets,
      inventory_deduction_enabled: false // always off at signup, enabled later once recipes exist
    };

    // NOTE: we deliberately do NOT chain .select() on this insert.
    // restaurants_select_member's policy checks is_member_of(id), and
    // that membership row is created by an AFTER INSERT trigger — so at
    // the exact moment PostgREST would evaluate the SELECT policy to
    // return the inserted row, the membership doesn't exist yet and the
    // whole operation gets rejected with a misleading RLS error on the
    // INSERT itself. Instead we insert, then re-fetch afterward once the
    // trigger has run and membership genuinely exists.
    const { error: insertError } = await req.supabase.from("restaurants").insert({
      name,
      city,
      owner_id: req.userId,
      business_type_label: businessTypeLabel,
      ...businessFeatures
    });

    if (insertError) {
      return res.status(500).json({ message: "Unable to create restaurant workspace" });
    }

    // Re-fetch the restaurant we just created. By now the AFTER INSERT
    // trigger has run, the membership row exists, and is_member_of(id)
    // will correctly return true for this user.
    const { data: restaurant, error: fetchError } = await req.supabase
      .from("restaurants")
      .select("*")
      .eq("owner_id", req.userId)
      .eq("name", name)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (fetchError || !restaurant) {
      return res.status(500).json({ message: "Restaurant created but could not be loaded" });
    }

    return res.status(201).json({ restaurant });
  } catch (err) {
    console.error("[POST /restaurants] Unexpected error:", err);
    return res.status(500).json({ message: "Unable to create restaurant workspace" });
  }
});

/**
 * PATCH /restaurants/current/features
 * Lets an owner adjust their 4 flags later from Settings — e.g. turning
 * on inventory_deduction_enabled once recipes are set up, or flipping
 * hasDelivery on for a stall that decides to start delivering.
 */
router.patch("/current/features", requireAuth, requireTenant, async (req, res) => {
  try {
    if (req.membershipRole !== "owner") {
      return res.status(403).json({ message: "Only the owner can change business features" });
    }

    const body = req.body || {};
    const updates = {};
    if (body.hasTables !== undefined) updates.has_tables = Boolean(body.hasTables);
    if (body.hasDelivery !== undefined) updates.has_delivery = Boolean(body.hasDelivery);
    if (body.hasMultipleOutlets !== undefined)
      updates.has_multiple_outlets = Boolean(body.hasMultipleOutlets);
    if (body.inventoryDeductionEnabled !== undefined)
      updates.inventory_deduction_enabled = Boolean(body.inventoryDeductionEnabled);

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: "No valid feature flags provided" });
    }

    const { data: updated, error } = await req.supabase
      .from("restaurants")
      .update(updates)
      .eq("id", req.restaurantId)
      .select()
      .single();

    if (error || !updated) {
      return res.status(500).json({ message: "Unable to update business features" });
    }

    return res.json({ restaurant: updated });
  } catch (err) {
    return res.status(500).json({ message: "Unable to update business features" });
  }
});

module.exports = router;

