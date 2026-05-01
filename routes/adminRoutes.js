const express = require("express");
const mongoose = require("mongoose");

const Restaurant = require("../models/Restaurant");
const User = require("../models/User");
const Order = require("../models/Order");
const Document = require("../models/Document");
const Expense = require("../models/Expense");
const requireAdminAccess = require("../middleware/adminAccess");

const router = express.Router();
router.use(requireAdminAccess);

const isDbConnected = () => mongoose.connection.readyState === 1;

const VALID_PLANS = new Set(["FREE", "BASIC", "PRO", "ENTERPRISE"]);
const VALID_ACCOUNT_STATUSES = new Set(["ACTIVE", "SUSPENDED"]);

const normalizePlan = (value) => String(value || "").trim().toUpperCase();
const normalizeStatus = (value) => String(value || "").trim().toUpperCase();

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(String(value || ""));

const parsePositiveInt = (value, fallback, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(Math.floor(parsed), max);
};

const parseDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
};

const summarizeUsageForRestaurant = async (restaurantId) => {
  const [ownerCount, staffCount, totalOrders, totalExpenses, documentStats] = await Promise.all([
    User.countDocuments({ restaurantId, role: "OWNER" }),
    User.countDocuments({ restaurantId, role: { $ne: "OWNER" } }),
    Order.countDocuments({ restaurantId }),
    Expense.countDocuments({ restaurantId }),
    Document.aggregate([
      { $match: { restaurantId } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          totalSize: { $sum: { $ifNull: ["$size", 0] } }
        }
      }
    ])
  ]);

  return {
    owners: ownerCount,
    staff: staffCount,
    orders: totalOrders,
    expenses: totalExpenses,
    documents: {
      count: Number(documentStats[0]?.count || 0),
      totalSizeBytes: Number(documentStats[0]?.totalSize || 0)
    }
  };
};

router.use((req, res, next) => {
  if (isDbConnected()) {
    return next();
  }

  return res.status(503).json({
    message: "Admin APIs require database mode"
  });
});

router.get("/overview", async (req, res) => {
  try {
    const [totals, byPlan, byStatus] = await Promise.all([
      Restaurant.countDocuments({}),
      Restaurant.aggregate([
        {
          $group: {
            _id: "$subscriptionPlan",
            count: { $sum: 1 }
          }
        }
      ]),
      Restaurant.aggregate([
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 }
          }
        }
      ])
    ]);

    return res.json({
      totalTenants: totals,
      byPlan: byPlan.reduce((acc, row) => {
        acc[String(row._id || "UNKNOWN")] = Number(row.count || 0);
        return acc;
      }, {}),
      byStatus: byStatus.reduce((acc, row) => {
        acc[String(row._id || "UNKNOWN")] = Number(row.count || 0);
        return acc;
      }, {})
    });
  } catch (err) {
    return res.serverError(err);
  }
});

router.get("/tenants", async (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page, 1);
    const limit = parsePositiveInt(req.query.limit, 20, 100);
    const search = String(req.query.search || "").trim();
    const status = normalizeStatus(req.query.status);
    const plan = normalizePlan(req.query.plan);

    const filter = {};

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { ownerName: { $regex: search, $options: "i" } }
      ];
    }

    if (VALID_ACCOUNT_STATUSES.has(status)) {
      filter.status = status;
    }

    if (VALID_PLANS.has(plan)) {
      filter.subscriptionPlan = plan;
    }

    const [total, items] = await Promise.all([
      Restaurant.countDocuments(filter),
      Restaurant.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
    ]);

    return res.json({
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit))
      }
    });
  } catch (err) {
    return res.serverError(err);
  }
});

router.get("/tenants/:id", async (req, res) => {
  try {
    const restaurantId = String(req.params.id || "");
    if (!isObjectId(restaurantId)) {
      return res.status(400).json({ message: "Invalid tenant id" });
    }

    const restaurant = await Restaurant.findById(restaurantId).lean();
    if (!restaurant) {
      return res.status(404).json({ message: "Tenant not found" });
    }

    const [owners, usage] = await Promise.all([
      User.find({ restaurantId, role: "OWNER" })
        .select("_id name email phone isActive createdAt")
        .lean(),
      summarizeUsageForRestaurant(restaurant._id)
    ]);

    return res.json({
      restaurant,
      owners,
      usage
    });
  } catch (err) {
    return res.serverError(err);
  }
});

router.patch("/tenants/:id/status", async (req, res) => {
  try {
    const restaurantId = String(req.params.id || "");
    if (!isObjectId(restaurantId)) {
      return res.status(400).json({ message: "Invalid tenant id" });
    }

    const status = normalizeStatus(req.body?.status);
    if (!VALID_ACCOUNT_STATUSES.has(status)) {
      return res.status(400).json({ message: "Invalid status. Use ACTIVE or SUSPENDED." });
    }

    const updated = await Restaurant.findByIdAndUpdate(
      restaurantId,
      { status },
      { new: true, runValidators: true }
    );

    if (!updated) {
      return res.status(404).json({ message: "Tenant not found" });
    }

    return res.json({
      message: `Tenant status updated to ${status}`,
      restaurant: updated
    });
  } catch (err) {
    return res.serverError(err);
  }
});

router.patch("/tenants/:id/plan", async (req, res) => {
  try {
    const restaurantId = String(req.params.id || "");
    if (!isObjectId(restaurantId)) {
      return res.status(400).json({ message: "Invalid tenant id" });
    }

    const plan = normalizePlan(req.body?.plan);
    if (!VALID_PLANS.has(plan)) {
      return res
        .status(400)
        .json({ message: "Invalid plan. Use FREE, BASIC, PRO or ENTERPRISE." });
    }

    let subscriptionExpiry = parseDate(req.body?.subscriptionExpiry);
    if (!subscriptionExpiry && plan !== "FREE") {
      const defaultDays = parsePositiveInt(req.body?.defaultDays, 30, 3650);
      subscriptionExpiry = new Date();
      subscriptionExpiry.setDate(subscriptionExpiry.getDate() + defaultDays);
    }

    const updates = {
      subscriptionPlan: plan,
      subscriptionExpiry: plan === "FREE" ? null : subscriptionExpiry,
      status: "ACTIVE"
    };

    const updated = await Restaurant.findByIdAndUpdate(restaurantId, updates, {
      new: true,
      runValidators: true
    });

    if (!updated) {
      return res.status(404).json({ message: "Tenant not found" });
    }

    return res.json({
      message: `Tenant plan updated to ${plan}`,
      restaurant: updated
    });
  } catch (err) {
    return res.serverError(err);
  }
});

router.post("/tenants/:id/force-signout", async (req, res) => {
  try {
    const restaurantId = String(req.params.id || "");
    if (!isObjectId(restaurantId)) {
      return res.status(400).json({ message: "Invalid tenant id" });
    }

    const restaurant = await Restaurant.findById(restaurantId).lean();
    if (!restaurant) {
      return res.status(404).json({ message: "Tenant not found" });
    }

    const result = await User.updateMany(
      { restaurantId },
      { $inc: { refreshTokenVersion: 1 } }
    );

    return res.json({
      message: "Forced signout applied to tenant users",
      affectedUsers: Number(result.modifiedCount || 0)
    });
  } catch (err) {
    return res.serverError(err);
  }
});

router.get("/tenants/:id/usage", async (req, res) => {
  try {
    const restaurantId = String(req.params.id || "");
    if (!isObjectId(restaurantId)) {
      return res.status(400).json({ message: "Invalid tenant id" });
    }

    const restaurant = await Restaurant.findById(restaurantId).lean();
    if (!restaurant) {
      return res.status(404).json({ message: "Tenant not found" });
    }

    const usage = await summarizeUsageForRestaurant(restaurant._id);
    return res.json({ usage });
  } catch (err) {
    return res.serverError(err);
  }
});

module.exports = router;
