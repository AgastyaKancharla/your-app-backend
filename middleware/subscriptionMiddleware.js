const mongoose = require("mongoose");
const Restaurant = require("../models/Restaurant");
const Subscription = require("../models/Subscription");
const { APP_CONFIG } = require("../config/appConfig");
const { resolveWorkspaceAccess } = require("../services/workspaceAccess");

const isDbConnected = () => mongoose.connection.readyState === 1;
const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const checkSubscription = async (req, res, next) => {
  try {
    const restaurantId = req.tenant?.restaurantId || req.user?.restaurantId;

    if (!restaurantId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (!isDbConnected()) {
      return res.status(503).json({
        message: "Database connection is not ready. Please retry in a moment."
      });
    }

    const [restaurant, subscription] = await Promise.all([
      Restaurant.findById(restaurantId).lean(),
      Subscription.findOne({ restaurantId }).lean()
    ]);

    if (!restaurant) {
      return res.status(404).json({ message: "Restaurant not found" });
    }

    if (restaurant.status && restaurant.status !== "ACTIVE") {
      return res.status(403).json({ message: "Restaurant account is not active" });
    }

    const workspaceAccess = resolveWorkspaceAccess({
      restaurant,
      subscription
    });

    req.restaurant = {
      ...restaurant,
      subscriptionPlan: workspaceAccess.plan,
      businessType: workspaceAccess.businessType
    };
    req.subscription = subscription || null;
    req.workspaceAccess = workspaceAccess;

    if (APP_CONFIG.DEV_MODE_UNLOCK_ALL) {
      return next();
    }

    if (workspaceAccess.isReadOnly && !READ_ONLY_METHODS.has(req.method)) {
      return res.status(403).json({
        message:
          "Your trial has ended. You can still view your data, but new changes are locked until you upgrade.",
        upgradeRequired: true,
        readOnlyMode: true,
        status: workspaceAccess.status,
        plan: workspaceAccess.plan,
        businessType: workspaceAccess.businessType
      });
    }

    return next();
  } catch (err) {
    return res.serverError(err);
  }
};

module.exports = checkSubscription;
