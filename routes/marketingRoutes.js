const express = require("express");

const MarketingCampaign = require("../models/MarketingCampaign");
const MarketingAutomation = require("../models/MarketingAutomation");
const Coupon = require("../models/Coupon");
const Customer = require("../models/Customer");
const requirePermission = require("../middleware/requirePermission");
const { requirePlanFeature } = require("../middleware/planLimitMiddleware");
const { getTenantRestaurantId, withTenantFilter } = require("../utils/tenantScope");

const router = express.Router();
router.use(
  requirePlanFeature("marketingTools", {
    requiredPlan: "GROWTH",
    message: "Marketing tools are available on GROWTH and above plans."
  })
);

const normalizeText = (value = "") => String(value || "").trim();
const normalizeCouponCode = (value = "") => normalizeText(value).toUpperCase();
const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

router.get("/overview", requirePermission("marketing.view"), async (req, res) => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [campaigns, coupons, customers, automations] = await Promise.all([
      MarketingCampaign.find(withTenantFilter(req)).sort({ createdAt: -1 }).limit(20),
      Coupon.find(withTenantFilter(req)).sort({ createdAt: -1 }),
      Customer.find(withTenantFilter(req)).sort({ loyaltyPoints: -1, lifetimeValue: -1 }).limit(25),
      MarketingAutomation.find(withTenantFilter(req)).sort({ createdAt: -1 }).limit(30)
    ]);

    const [
      totalCustomers,
      whatsappAudience,
      smsAudience,
      repeatCustomers,
      highValueCustomers,
      inactive30Days,
      active30Days
    ] = await Promise.all([
      Customer.countDocuments(withTenantFilter(req)),
      Customer.countDocuments(withTenantFilter(req, { "marketingPreferences.whatsapp": true })),
      Customer.countDocuments(withTenantFilter(req, { "marketingPreferences.sms": true })),
      Customer.countDocuments(withTenantFilter(req, { orderCount: { $gte: 2 } })),
      Customer.countDocuments(withTenantFilter(req, { lifetimeValue: { $gte: 3000 } })),
      Customer.countDocuments(withTenantFilter(req, { lastOrderAt: { $lte: thirtyDaysAgo } })),
      Customer.countDocuments(withTenantFilter(req, { lastOrderAt: { $gt: thirtyDaysAgo } }))
    ]);

    return res.json({
      campaigns,
      coupons,
      automations,
      loyaltyLeaders: customers,
      referralLeaders: [...customers].sort((a, b) => Number(b.totalReferrals || 0) - Number(a.totalReferrals || 0)),
      segmentCounts: {
        totalCustomers,
        whatsappAudience,
        smsAudience,
        repeatCustomers,
        highValueCustomers,
        inactive30Days,
        active30Days
      }
    });
  } catch (err) {
    return res.serverError(err);
  }
});

router.post("/campaigns", requirePermission("marketing.create"), async (req, res) => {
  try {
    const restaurantId = getTenantRestaurantId(req);
    const channel = normalizeText(req.body?.channel).toUpperCase();
    const title = normalizeText(req.body?.title);
    const message = normalizeText(req.body?.message);

    if (!["WHATSAPP", "SMS"].includes(channel)) {
      return res.status(400).json({ message: "Use WHATSAPP or SMS channel" });
    }

    if (!title || !message) {
      return res.status(400).json({ message: "Campaign title and message are required" });
    }

    const audienceKey = channel === "WHATSAPP" ? "marketingPreferences.whatsapp" : "marketingPreferences.sms";
    const audienceCount = await Customer.countDocuments(
      withTenantFilter(req, { [audienceKey]: true })
    );

    const created = await MarketingCampaign.create({
      restaurantId,
      channel,
      title,
      message,
      couponCode: normalizeCouponCode(req.body?.couponCode),
      audienceCount,
      createdBy: req.user?.userId || null,
      status: "SENT"
    });

    return res.status(201).json(created);
  } catch (err) {
    return res.serverError(err);
  }
});

router.post("/coupons", requirePermission("marketing.create"), async (req, res) => {
  try {
    const restaurantId = getTenantRestaurantId(req);
    const code = normalizeCouponCode(req.body?.code);

    if (!code) {
      return res.status(400).json({ message: "Coupon code is required" });
    }

    const payload = {
      restaurantId,
      code,
      title: normalizeText(req.body?.title),
      discountType:
        normalizeText(req.body?.discountType).toUpperCase() === "FLAT" ? "FLAT" : "PERCENTAGE",
      discountValue: Math.max(0, toNumber(req.body?.discountValue)),
      minOrderValue: Math.max(0, toNumber(req.body?.minOrderValue)),
      expiresAt: req.body?.expiresAt ? new Date(req.body.expiresAt) : null,
      isActive: req.body?.isActive === undefined ? true : Boolean(req.body.isActive)
    };

    const created = await Coupon.findOneAndUpdate(
      { restaurantId, code },
      { $set: payload, $setOnInsert: { usageCount: 0 } },
      { upsert: true, new: true, runValidators: true }
    );

    return res.status(201).json(created);
  } catch (err) {
    return res.serverError(err);
  }
});

router.get("/automations", requirePermission("marketing.view"), async (req, res) => {
  try {
    const rules = await MarketingAutomation.find(withTenantFilter(req)).sort({ createdAt: -1 });
    return res.json(rules);
  } catch (err) {
    return res.serverError(err);
  }
});

router.post("/automations", requirePermission("marketing.create"), async (req, res) => {
  try {
    const restaurantId = getTenantRestaurantId(req);
    const name = normalizeText(req.body?.name);
    const messageTemplate = normalizeText(req.body?.messageTemplate);
    if (!name || !messageTemplate) {
      return res.status(400).json({ message: "Automation name and template are required" });
    }

    const triggerType = normalizeText(req.body?.triggerType).toUpperCase();
    const channel = normalizeText(req.body?.channel).toUpperCase();

    if (!["INACTIVE_30_DAYS", "FIRST_ORDER", "LOYALTY_MILESTONE", "MANUAL_SEGMENT"].includes(triggerType)) {
      return res.status(400).json({ message: "Invalid automation trigger type" });
    }
    if (!["WHATSAPP", "SMS"].includes(channel)) {
      return res.status(400).json({ message: "Invalid automation channel" });
    }

    const created = await MarketingAutomation.create({
      restaurantId,
      name,
      triggerType,
      channel,
      messageTemplate,
      couponCode: normalizeCouponCode(req.body?.couponCode),
      isActive: req.body?.isActive === undefined ? true : Boolean(req.body.isActive),
      createdBy: req.user?.userId || null
    });

    return res.status(201).json(created);
  } catch (err) {
    return res.serverError(err);
  }
});

router.put("/automations/:id/toggle", requirePermission("marketing.update"), async (req, res) => {
  try {
    const automation = await MarketingAutomation.findOneAndUpdate(
      withTenantFilter(req, { _id: req.params.id }),
      {
        isActive: Boolean(req.body?.isActive)
      },
      { new: true }
    );

    if (!automation) {
      return res.status(404).json({ message: "Automation rule not found" });
    }

    return res.json(automation);
  } catch (err) {
    return res.serverError(err);
  }
});

module.exports = router;
