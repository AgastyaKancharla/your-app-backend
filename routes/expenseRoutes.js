const express = require("express");

const Expense = require("../models/Expense");
const auditActivity = require("../middleware/auditActivity");
const requirePermission = require("../middleware/requirePermission");
const {
  getTenantRestaurantId,
  withTenantFilter
} = require("../utils/tenantScope");
const { requirePlanFeature } = require("../middleware/planLimitMiddleware");

const router = express.Router();
router.use(
  requirePlanFeature("expenseManagement", {
    requiredPlan: "GROWTH",
    message: "Expense management is available on GROWTH and above plans."
  })
);

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

router.get("/", requirePermission("expenses.view"), async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;

    const filter = withTenantFilter(req);
    if (from || to) {
      filter.createdAt = {};
      if (from && !Number.isNaN(from.getTime())) {
        from.setHours(0, 0, 0, 0);
        filter.createdAt.$gte = from;
      }
      if (to && !Number.isNaN(to.getTime())) {
        to.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = to;
      }
    }

    const expenses = await Expense.find(filter).sort({ createdAt: -1 });
    const totalAmount = expenses.reduce((sum, e) => sum + toNumber(e.amount), 0);

    return res.json({
      totalAmount,
      count: expenses.length,
      expenses
    });
  } catch (err) {
    return res.serverError(err);
  }
});

router.post("/", requirePermission("expenses.create"), auditActivity({ action: "Expense added", module: "Finance" }), async (req, res) => {
  try {
    const restaurantId = getTenantRestaurantId(req);

    const category = String(req.body?.category || "").trim();
    const amount = Math.max(0, toNumber(req.body?.amount));
    const description = String(req.body?.description || "").trim();

    if (!category) {
      return res.status(400).json({ message: "Expense category is required" });
    }

    if (amount <= 0) {
      return res.status(400).json({ message: "Expense amount must be greater than zero" });
    }

    const created = await Expense.create({
      restaurantId,
      category,
      amount,
      description,
      createdBy: req.user?.userId || null
    });

    return res.status(201).json(created);
  } catch (err) {
    return res.serverError(err);
  }
});

module.exports = router;
