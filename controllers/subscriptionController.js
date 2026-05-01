const Restaurant = require("../models/Restaurant");
const Subscription = require("../models/Subscription");
const Order = require("../models/Order");
const Customer = require("../models/Customer");
const { getTenantRestaurantId } = require("../utils/tenantScope");
const { getPlanConfig, normalizeSaasPlan, getPlanExpiryDate } = require("../services/subscriptionPlans");
const { resolveWorkspaceAccess } = require("../services/workspaceAccess");

const buildUsageHighlights = async (restaurantId) => {
  const [ordersTracked, customersAdded, revenue] = await Promise.all([
    Order.countDocuments({ restaurantId }),
    Customer.countDocuments({ restaurantId }),
    Order.aggregate([
      {
        $match: {
          restaurantId
        }
      },
      {
        $group: {
          _id: null,
          totalRevenueLogged: {
            $sum: {
              $ifNull: ["$grandTotal", "$totalAmount"]
            }
          }
        }
      }
    ])
  ]);

  return {
    ordersTracked,
    customersAdded,
    totalRevenueLogged: Number(revenue[0]?.totalRevenueLogged || 0)
  };
};

const buildTrialReminder = (workspaceAccess, usageHighlights) => {
  if (workspaceAccess.status !== "TRIAL") {
    return null;
  }

  const daysLeft = Math.max(0, Number(workspaceAccess.daysLeft || 0));
  const trialDay = Number(workspaceAccess.trialDay || 0);
  const shouldSendNow = daysLeft > 0 && trialDay >= 10;

  return {
    eligibleFromDay: 10,
    shouldSendNow,
    title: shouldSendNow
      ? `${daysLeft} day${daysLeft === 1 ? "" : "s"} left in your trial`
      : "Trial progress is being tracked",
    message: shouldSendNow
      ? `Show them their own results: ${usageHighlights.ordersTracked} orders tracked and INR ${usageHighlights.totalRevenueLogged.toLocaleString("en-IN")} revenue logged so far.`
      : "Use trial data to drive conversion reminders as the trial approaches expiry."
  };
};

const getSubscriptionStatus = async (req, res) => {
  try {
    const restaurantId = getTenantRestaurantId(req);
    if (!restaurantId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const [restaurant, subscription] = await Promise.all([
      Restaurant.findById(restaurantId).lean(),
      Subscription.findOne({ restaurantId }).lean()
    ]);

    if (!restaurant) {
      return res.status(404).json({ message: "Restaurant not found" });
    }

    const workspaceAccess = resolveWorkspaceAccess({
      restaurant,
      subscription
    });
    const planConfig = getPlanConfig(workspaceAccess.plan);
    const usageHighlights = await buildUsageHighlights(restaurant._id);

    return res.json({
      restaurantId,
      businessType: workspaceAccess.businessType,
      businessTypeLabel: workspaceAccess.businessTypeLabel,
      plan: workspaceAccess.plan,
      planLabel: workspaceAccess.planLabel,
      status: workspaceAccess.status,
      accessMode: workspaceAccess.accessMode,
      isReadOnly: workspaceAccess.isReadOnly,
      startDate: workspaceAccess.startDate,
      expiryDate: workspaceAccess.expiryDate,
      trialEndsAt: workspaceAccess.trialEndsAt,
      daysLeft: workspaceAccess.daysLeft,
      trialDay: workspaceAccess.trialDay,
      trialDurationDays: workspaceAccess.trialDurationDays,
      pricing: {
        inrMonthly: planConfig.monthlyPriceInr,
        inrYearly: planConfig.yearlyPriceInr,
        annualDiscountMonthsFree: planConfig.annualDiscountMonthsFree || 0
      },
      limits: {
        maxStaffAccounts: planConfig.maxStaffAccounts,
        maxDocuments: workspaceAccess.limits.maxDocuments,
        maxReportDays: workspaceAccess.limits.maxReportDays
      },
      features: workspaceAccess.features,
      modules: workspaceAccess.modules,
      enabledPages: workspaceAccess.enabledPages,
      lockedPages: workspaceAccess.lockedPages,
      usageHighlights,
      trialReminder: buildTrialReminder(workspaceAccess, usageHighlights)
    });
  } catch (err) {
    return res.serverError(err, { fallbackMessage: "Unable to fetch subscription status." });
  }
};

const selectSubscriptionPlan = async (req, res) => {
  try {
    const restaurantId = getTenantRestaurantId(req);
    if (!restaurantId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const selectedPlan = normalizeSaasPlan(req.body?.plan);
    const billingCycle = String(req.body?.billingCycle || "MONTHLY").trim().toUpperCase();
    const planConfig = getPlanConfig(selectedPlan);
    if (!planConfig?.code) {
      return res.status(400).json({ message: "Invalid plan selected" });
    }

    const restaurant = await Restaurant.findById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ message: "Restaurant not found" });
    }

    const now = new Date();
    const durationMonths = billingCycle === "YEARLY" ? 12 : 1;
    const expiryDate = getPlanExpiryDate(now, durationMonths);
    const subscription = await Subscription.findOneAndUpdate(
      { restaurantId },
      {
        restaurantId,
        plan: planConfig.code,
        status: "ACTIVE",
        startDate: now,
        expiryDate,
        trialEndsAt: null
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true
      }
    ).lean();

    restaurant.subscriptionPlan = planConfig.code;
    restaurant.subscriptionExpiry = expiryDate;
    await restaurant.save();

    return res.status(200).json({
      message: "Plan selected successfully",
      subscription: {
        restaurantId: subscription.restaurantId,
        plan: subscription.plan,
        status: subscription.status,
        startDate: subscription.startDate,
        expiryDate: subscription.expiryDate,
        trialEndsAt: subscription.trialEndsAt
      },
      billingCycle,
      pricing: {
        inrMonthly: planConfig.monthlyPriceInr,
        inrYearly: planConfig.yearlyPriceInr,
        annualDiscountMonthsFree: planConfig.annualDiscountMonthsFree || 0
      }
    });
  } catch (err) {
    return res.serverError(err, { fallbackMessage: "Unable to update subscription plan." });
  }
};

module.exports = {
  getSubscriptionStatus,
  selectSubscriptionPlan
};
