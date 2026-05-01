const express = require("express");

const Table = require("../models/Table");
const authorizeRoles = require("../middleware/authorizeRoles");
const { requirePlanFeature } = require("../middleware/planLimitMiddleware");
const { TABLE_MANAGEMENT_ROLES } = require("../utils/accessControl");
const {
  getTenantRestaurantId,
  withTenantFilter,
  withTenantDocFilter
} = require("../utils/tenantScope");

const router = express.Router();

router.use(
  requirePlanFeature("tableManagement", {
    requiredPlan: "PRO",
    message: "Table management is available on PRO and above plans."
  })
);

const normalizeText = (value = "") => String(value || "").trim();
const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const normalizeStatus = (value = "") => {
  const status = String(value || "").trim().toUpperCase();
  if (["AVAILABLE", "OCCUPIED", "RESERVED", "CLEANING"].includes(status)) {
    return status;
  }
  return "AVAILABLE";
};

router.get("/", authorizeRoles(TABLE_MANAGEMENT_ROLES), async (req, res) => {
  try {
    const tables = await Table.find(withTenantFilter(req)).sort({ code: 1, createdAt: 1 });
    return res.json(tables);
  } catch (err) {
    return res.serverError(err);
  }
});

router.post("/", authorizeRoles(TABLE_MANAGEMENT_ROLES), async (req, res) => {
  try {
    const restaurantId = getTenantRestaurantId(req);
    const code = normalizeText(req.body?.code).toUpperCase();
    if (!code) {
      return res.status(400).json({ message: "Table code is required" });
    }

    const created = await Table.create({
      restaurantId,
      code,
      displayName: normalizeText(req.body?.displayName) || code,
      capacity: Math.max(1, toNumber(req.body?.capacity, 2)),
      status: normalizeStatus(req.body?.status),
      notes: normalizeText(req.body?.notes)
    });

    return res.status(201).json(created);
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ message: "Table code already exists" });
    }
    return res.serverError(err);
  }
});

router.put("/:id", authorizeRoles(TABLE_MANAGEMENT_ROLES), async (req, res) => {
  try {
    const updates = {
      displayName: normalizeText(req.body?.displayName),
      capacity: Math.max(1, toNumber(req.body?.capacity, 2)),
      notes: normalizeText(req.body?.notes)
    };

    if (req.body?.code !== undefined) {
      const code = normalizeText(req.body.code).toUpperCase();
      if (!code) {
        return res.status(400).json({ message: "Table code is required" });
      }
      updates.code = code;
    }

    if (req.body?.status !== undefined) {
      updates.status = normalizeStatus(req.body.status);
    }
    if (req.body?.currentCustomerName !== undefined) {
      updates.currentCustomerName = normalizeText(req.body.currentCustomerName);
    }
    if (req.body?.currentOrderId !== undefined) {
      updates.currentOrderId = req.body.currentOrderId || null;
    }

    const table = await Table.findOneAndUpdate(withTenantDocFilter(req, req.params.id), updates, {
      new: true,
      runValidators: true
    });
    if (!table) {
      return res.status(404).json({ message: "Table not found" });
    }

    return res.json(table);
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ message: "Table code already exists" });
    }
    return res.serverError(err);
  }
});

router.put("/:id/status", authorizeRoles(TABLE_MANAGEMENT_ROLES), async (req, res) => {
  try {
    const table = await Table.findOneAndUpdate(
      withTenantDocFilter(req, req.params.id),
      {
        status: normalizeStatus(req.body?.status),
        currentCustomerName: normalizeText(req.body?.currentCustomerName),
        currentOrderId: req.body?.currentOrderId || null
      },
      { new: true, runValidators: true }
    );

    if (!table) {
      return res.status(404).json({ message: "Table not found" });
    }

    return res.json(table);
  } catch (err) {
    return res.serverError(err);
  }
});

router.delete("/:id", authorizeRoles(TABLE_MANAGEMENT_ROLES), async (req, res) => {
  try {
    const deleted = await Table.findOneAndDelete(withTenantDocFilter(req, req.params.id));
    if (!deleted) {
      return res.status(404).json({ message: "Table not found" });
    }
    return res.json({ message: "Table removed" });
  } catch (err) {
    return res.serverError(err);
  }
});

module.exports = router;
