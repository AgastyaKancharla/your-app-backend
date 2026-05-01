const express = require("express");

const Supplier = require("../models/Supplier");
const authorizeRoles = require("../middleware/authorizeRoles");
const { requirePlanFeature } = require("../middleware/planLimitMiddleware");
const { SUPPLIER_MANAGEMENT_ROLES } = require("../utils/accessControl");
const {
  getTenantRestaurantId,
  withTenantFilter,
  withTenantDocFilter
} = require("../utils/tenantScope");

const router = express.Router();

router.use(
  requirePlanFeature("supplierManagement", {
    requiredPlan: "GROWTH",
    message: "Supplier management is available on GROWTH and above plans."
  })
);

const normalizeText = (value = "") => String(value || "").trim();

router.get("/", authorizeRoles(SUPPLIER_MANAGEMENT_ROLES), async (req, res) => {
  try {
    const suppliers = await Supplier.find(withTenantFilter(req)).sort({
      isActive: -1,
      name: 1
    });
    return res.json(suppliers);
  } catch (err) {
    return res.serverError(err);
  }
});

router.post("/", authorizeRoles(SUPPLIER_MANAGEMENT_ROLES), async (req, res) => {
  try {
    const restaurantId = getTenantRestaurantId(req);
    const name = normalizeText(req.body?.name);
    if (!name) {
      return res.status(400).json({ message: "Supplier name is required" });
    }

    const created = await Supplier.create({
      restaurantId,
      name,
      contactPerson: normalizeText(req.body?.contactPerson),
      phone: normalizeText(req.body?.phone),
      email: normalizeText(req.body?.email).toLowerCase(),
      gstNumber: normalizeText(req.body?.gstNumber),
      address: normalizeText(req.body?.address),
      notes: normalizeText(req.body?.notes),
      isActive: req.body?.isActive === undefined ? true : Boolean(req.body.isActive)
    });

    return res.status(201).json(created);
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ message: "Supplier already exists" });
    }
    return res.serverError(err);
  }
});

router.put("/:id", authorizeRoles(SUPPLIER_MANAGEMENT_ROLES), async (req, res) => {
  try {
    const updates = {};
    if (req.body?.name !== undefined) {
      const name = normalizeText(req.body.name);
      if (!name) {
        return res.status(400).json({ message: "Supplier name is required" });
      }
      updates.name = name;
    }
    if (req.body?.contactPerson !== undefined) {
      updates.contactPerson = normalizeText(req.body.contactPerson);
    }
    if (req.body?.phone !== undefined) {
      updates.phone = normalizeText(req.body.phone);
    }
    if (req.body?.email !== undefined) {
      updates.email = normalizeText(req.body.email).toLowerCase();
    }
    if (req.body?.gstNumber !== undefined) {
      updates.gstNumber = normalizeText(req.body.gstNumber);
    }
    if (req.body?.address !== undefined) {
      updates.address = normalizeText(req.body.address);
    }
    if (req.body?.notes !== undefined) {
      updates.notes = normalizeText(req.body.notes);
    }
    if (req.body?.isActive !== undefined) {
      updates.isActive = Boolean(req.body.isActive);
    }

    const updated = await Supplier.findOneAndUpdate(
      withTenantDocFilter(req, req.params.id),
      updates,
      { new: true, runValidators: true }
    );
    if (!updated) {
      return res.status(404).json({ message: "Supplier not found" });
    }

    return res.json(updated);
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ message: "Supplier already exists" });
    }
    return res.serverError(err);
  }
});

router.delete("/:id", authorizeRoles(SUPPLIER_MANAGEMENT_ROLES), async (req, res) => {
  try {
    const deleted = await Supplier.findOneAndDelete(withTenantDocFilter(req, req.params.id));
    if (!deleted) {
      return res.status(404).json({ message: "Supplier not found" });
    }
    return res.json({ message: "Supplier deleted" });
  } catch (err) {
    return res.serverError(err);
  }
});

module.exports = router;
