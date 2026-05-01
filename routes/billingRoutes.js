const express = require("express");

const Restaurant = require("../models/Restaurant");
const authorizeRoles = require("../middleware/authorizeRoles");
const { getTenantRestaurantId } = require("../utils/tenantScope");
const {
  normalizePlan,
  getPriceIdForPlan,
  createStripeCustomer,
  createStripeCheckoutSession,
  createStripePortalSession
} = require("../services/stripeBilling");

const router = express.Router();
router.use(authorizeRoles(["OWNER"]));

const isValidHttpUrl = (value) => {
  const input = String(value || "").trim();
  if (!input) {
    return false;
  }

  try {
    const parsed = new URL(input);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

router.get("/status", async (req, res) => {
  try {
    const restaurantId = getTenantRestaurantId(req);
    const restaurant = await Restaurant.findById(restaurantId).lean();

    if (!restaurant) {
      return res.status(404).json({ message: "Restaurant not found" });
    }

    return res.json({
      plan: restaurant.subscriptionPlan || "STARTER",
      subscriptionExpiry: restaurant.subscriptionExpiry || null,
      accountStatus: restaurant.status || "ACTIVE",
      billingProvider: restaurant.billingProvider || "NONE",
      billingStatus: restaurant.billingStatus || "inactive",
      billingCustomerId: restaurant.billingCustomerId || "",
      billingSubscriptionId: restaurant.billingSubscriptionId || "",
      billingCurrentPeriodEnd: restaurant.billingCurrentPeriodEnd || null,
      billingLastWebhookAt: restaurant.billingLastWebhookAt || null
    });
  } catch (err) {
    return res.serverError(err);
  }
});

router.post("/checkout-session", async (req, res) => {
  try {
    const restaurantId = getTenantRestaurantId(req);
    const requestedPlan = normalizePlan(req.body?.plan);
    const successUrl =
      String(req.body?.successUrl || process.env.STRIPE_CHECKOUT_SUCCESS_URL || "").trim();
    const cancelUrl =
      String(req.body?.cancelUrl || process.env.STRIPE_CHECKOUT_CANCEL_URL || "").trim();

    if (!requestedPlan) {
      return res.status(400).json({ message: "Please choose a paid plan" });
    }

    if (!isValidHttpUrl(successUrl) || !isValidHttpUrl(cancelUrl)) {
      return res.status(400).json({
        message: "Valid successUrl and cancelUrl are required"
      });
    }

    const restaurant = await Restaurant.findById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ message: "Restaurant not found" });
    }

    const priceId = getPriceIdForPlan(requestedPlan);

    let customerId = String(restaurant.billingCustomerId || "").trim();
    if (!customerId) {
      const customer = await createStripeCustomer({ restaurant });
      customerId = customer.id;

      restaurant.billingProvider = "STRIPE";
      restaurant.billingCustomerId = customerId;
      await restaurant.save();
    }

    const session = await createStripeCheckoutSession({
      customerId,
      priceId,
      successUrl,
      cancelUrl,
      metadata: {
        restaurantId: String(restaurant._id),
        plan: requestedPlan
      }
    });

    return res.json({
      sessionId: session.id,
      checkoutUrl: session.url
    });
  } catch (err) {
    return res.serverError(err);
  }
});

router.post("/portal-session", async (req, res) => {
  try {
    const restaurantId = getTenantRestaurantId(req);
    const returnUrl = String(req.body?.returnUrl || process.env.STRIPE_PORTAL_RETURN_URL || "").trim();

    if (!isValidHttpUrl(returnUrl)) {
      return res.status(400).json({ message: "Valid returnUrl is required" });
    }

    const restaurant = await Restaurant.findById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ message: "Restaurant not found" });
    }

    const customerId = String(restaurant.billingCustomerId || "").trim();
    if (!customerId) {
      return res.status(400).json({
        message: "No billing customer found for this restaurant. Start a subscription first."
      });
    }

    const portal = await createStripePortalSession({
      customerId,
      returnUrl
    });

    return res.json({
      url: portal.url
    });
  } catch (err) {
    return res.serverError(err);
  }
});

module.exports = router;
