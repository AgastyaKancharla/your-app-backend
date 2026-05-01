const express = require("express");

const PurchaseOrder = require("../models/PurchaseOrder");
const Supplier = require("../models/Supplier");
const Ingredient = require("../models/Ingredient");
const authorizeRoles = require("../middleware/authorizeRoles");
const { requirePlanFeature } = require("../middleware/planLimitMiddleware");
const { PURCHASE_ORDER_ROLES } = require("../utils/accessControl");
const {
  getTenantRestaurantId,
  withTenantFilter,
  withTenantDocFilter
} = require("../utils/tenantScope");

const router = express.Router();

router.use(
  requirePlanFeature("purchaseOrders", {
    requiredPlan: "GROWTH",
    message: "Purchase orders are available on GROWTH and above plans."
  })
);

const normalizeText = (value = "") => String(value || "").trim();
const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeLineItems = (lines = []) => {
  if (!Array.isArray(lines)) {
    return [];
  }

  return lines
    .map((line) => {
      const ingredientName = normalizeText(line?.ingredientName);
      const quantity = Math.max(0, toNumber(line?.quantity));
      const unitPrice = Math.max(0, toNumber(line?.unitPrice));
      const unit = normalizeText(line?.unit) || "kg";
      const lineTotal = Number((quantity * unitPrice).toFixed(2));
      return {
        ingredientName,
        quantity,
        unit,
        unitPrice,
        lineTotal
      };
    })
    .filter((line) => line.ingredientName && line.quantity > 0);
};

const buildPONumber = async (restaurantId) => {
  const count = await PurchaseOrder.countDocuments({ restaurantId });
  const serial = String(count + 1).padStart(5, "0");
  const date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `PO-${y}${m}${d}-${serial}`;
};

router.get("/", authorizeRoles(PURCHASE_ORDER_ROLES), async (req, res) => {
  try {
    const purchaseOrders = await PurchaseOrder.find(withTenantFilter(req))
      .sort({ createdAt: -1 })
      .limit(300);
    return res.json(purchaseOrders);
  } catch (err) {
    return res.serverError(err);
  }
});

router.post("/", authorizeRoles(PURCHASE_ORDER_ROLES), async (req, res) => {
  try {
    const restaurantId = getTenantRestaurantId(req);
    const supplierId = normalizeText(req.body?.supplierId);
    const lines = normalizeLineItems(req.body?.lines);
    if (!lines.length) {
      return res.status(400).json({ message: "Add at least one purchase line item." });
    }

    const supplier = supplierId
      ? await Supplier.findOne(withTenantDocFilter(req, supplierId))
      : null;

    const subtotal = lines.reduce((sum, line) => sum + Number(line.lineTotal || 0), 0);
    const taxAmount = Math.max(0, toNumber(req.body?.taxAmount));
    const totalAmount = Number((subtotal + taxAmount).toFixed(2));
    const poNumber = await buildPONumber(restaurantId);

    const created = await PurchaseOrder.create({
      restaurantId,
      poNumber,
      supplierId: supplier?._id || null,
      supplierName: supplier?.name || normalizeText(req.body?.supplierName),
      lines,
      subtotal,
      taxAmount,
      totalAmount,
      expectedDate: req.body?.expectedDate ? new Date(req.body.expectedDate) : null,
      status: ["DRAFT", "ORDERED", "RECEIVED", "CANCELLED"].includes(
        String(req.body?.status || "").toUpperCase()
      )
        ? String(req.body.status).toUpperCase()
        : "DRAFT",
      notes: normalizeText(req.body?.notes),
      createdBy: req.user?.userId || null
    });

    return res.status(201).json(created);
  } catch (err) {
    return res.serverError(err);
  }
});

router.put("/:id", authorizeRoles(PURCHASE_ORDER_ROLES), async (req, res) => {
  try {
    const existing = await PurchaseOrder.findOne(withTenantDocFilter(req, req.params.id));
    if (!existing) {
      return res.status(404).json({ message: "Purchase order not found" });
    }

    if (existing.status === "RECEIVED" || existing.status === "CANCELLED") {
      return res.status(400).json({
        message: "Received or cancelled purchase orders cannot be edited."
      });
    }

    const lines = normalizeLineItems(req.body?.lines);
    if (!lines.length) {
      return res.status(400).json({ message: "Add at least one purchase line item." });
    }

    const supplierId = normalizeText(req.body?.supplierId);
    const supplier = supplierId
      ? await Supplier.findOne(withTenantDocFilter(req, supplierId))
      : null;

    const subtotal = lines.reduce((sum, line) => sum + Number(line.lineTotal || 0), 0);
    const taxAmount = Math.max(0, toNumber(req.body?.taxAmount));
    const totalAmount = Number((subtotal + taxAmount).toFixed(2));

    existing.supplierId = supplier?._id || null;
    existing.supplierName = supplier?.name || normalizeText(req.body?.supplierName);
    existing.lines = lines;
    existing.subtotal = subtotal;
    existing.taxAmount = taxAmount;
    existing.totalAmount = totalAmount;
    existing.expectedDate = req.body?.expectedDate ? new Date(req.body.expectedDate) : null;
    existing.notes = normalizeText(req.body?.notes);
    if (req.body?.status) {
      const nextStatus = String(req.body.status).toUpperCase();
      if (["DRAFT", "ORDERED", "RECEIVED", "CANCELLED"].includes(nextStatus)) {
        existing.status = nextStatus;
      }
    }

    await existing.save();
    return res.json(existing);
  } catch (err) {
    return res.serverError(err);
  }
});

router.put("/:id/status", authorizeRoles(PURCHASE_ORDER_ROLES), async (req, res) => {
  try {
    const purchaseOrder = await PurchaseOrder.findOne(withTenantDocFilter(req, req.params.id));
    if (!purchaseOrder) {
      return res.status(404).json({ message: "Purchase order not found" });
    }

    const nextStatus = String(req.body?.status || "").trim().toUpperCase();
    if (!["DRAFT", "ORDERED", "RECEIVED", "CANCELLED"].includes(nextStatus)) {
      return res.status(400).json({ message: "Invalid purchase order status" });
    }

    if (purchaseOrder.status === "RECEIVED" || purchaseOrder.status === "CANCELLED") {
      return res.status(400).json({
        message: "Purchase order is closed and cannot be changed."
      });
    }

    purchaseOrder.status = nextStatus;
    if (nextStatus === "RECEIVED") {
      const restaurantId = getTenantRestaurantId(req);
      purchaseOrder.receivedAt = new Date();

      for (const line of purchaseOrder.lines) {
        const ingredientName = normalizeText(line.ingredientName);
        if (!ingredientName) {
          continue;
        }

        const quantity = Math.max(0, toNumber(line.quantity));
        const unitPrice = Math.max(0, toNumber(line.unitPrice));
        const unit = normalizeText(line.unit) || "kg";

        await Ingredient.findOneAndUpdate(
          withTenantFilter(req, { name: ingredientName }),
          {
            $setOnInsert: {
              restaurantId,
              name: ingredientName,
              minStock: 0
            },
            $set: {
              unit,
              pricePerUnit: unitPrice,
              purchasePrice: unitPrice
            },
            $inc: {
              quantity,
              currentStock: quantity
            }
          },
          { upsert: true, new: true }
        );
      }
    }

    await purchaseOrder.save();
    return res.json(purchaseOrder);
  } catch (err) {
    return res.serverError(err);
  }
});

router.delete("/:id", authorizeRoles(PURCHASE_ORDER_ROLES), async (req, res) => {
  try {
    const deleted = await PurchaseOrder.findOneAndDelete(withTenantDocFilter(req, req.params.id));
    if (!deleted) {
      return res.status(404).json({ message: "Purchase order not found" });
    }
    return res.json({ message: "Purchase order deleted" });
  } catch (err) {
    return res.serverError(err);
  }
});

module.exports = router;
