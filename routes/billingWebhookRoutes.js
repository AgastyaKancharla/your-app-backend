const express = require("express");
const mongoose = require("mongoose");

const ProcessedWebhookEvent = require("../models/ProcessedWebhookEvent");
const Restaurant = require("../models/Restaurant");
const {
  verifyStripeWebhookSignature,
  toDateFromUnix,
  mapBillingStatusToRestaurantStatus,
  derivePlanFromSubscriptionObject,
  normalizePlan
} = require("../services/stripeBilling");

const router = express.Router();

const findRestaurantForStripeObject = async (object = {}) => {
  const metadataRestaurantId = String(
    object?.metadata?.restaurantId ||
      object?.subscription_details?.metadata?.restaurantId ||
      ""
  ).trim();
  const customerId = String(object?.customer || "").trim();
  const subscriptionId = String(
    object?.subscription ||
      (object?.object === "subscription" ? object?.id : "") ||
      ""
  ).trim();

  if (metadataRestaurantId && mongoose.Types.ObjectId.isValid(metadataRestaurantId)) {
    const byId = await Restaurant.findById(metadataRestaurantId);
    if (byId) {
      return byId;
    }
  }

  if (subscriptionId) {
    const bySubscription = await Restaurant.findOne({
      billingSubscriptionId: subscriptionId
    });
    if (bySubscription) {
      return bySubscription;
    }
  }

  if (customerId) {
    const byCustomer = await Restaurant.findOne({
      billingCustomerId: customerId
    });
    if (byCustomer) {
      return byCustomer;
    }
  }

  return null;
};

const applySubscriptionObjectToRestaurant = (restaurant, subscription, fallbackPlan = "") => {
  const billingStatus = String(subscription?.status || "inactive").trim().toLowerCase();
  const nextPlan = derivePlanFromSubscriptionObject(subscription, fallbackPlan);
  const periodEnd = toDateFromUnix(subscription?.current_period_end);

  restaurant.billingProvider = "STRIPE";
  restaurant.billingStatus = billingStatus || "inactive";
  restaurant.billingCurrentPeriodEnd = periodEnd;
  restaurant.billingLastWebhookAt = new Date();

  if (subscription?.customer) {
    restaurant.billingCustomerId = String(subscription.customer);
  }

  if (subscription?.id) {
    restaurant.billingSubscriptionId = String(subscription.id);
  }

  restaurant.subscriptionPlan = nextPlan;
  restaurant.subscriptionExpiry = periodEnd;
  restaurant.status = mapBillingStatusToRestaurantStatus(billingStatus);
};

const handleStripeEvent = async (event) => {
  const eventType = String(event?.type || "").trim();
  const object = event?.data?.object || {};

  if (!eventType) {
    return;
  }

  if (eventType === "checkout.session.completed") {
    if (object?.mode !== "subscription") {
      return;
    }

    const restaurant = await findRestaurantForStripeObject(object);
    if (!restaurant) {
      return;
    }

    const plan = normalizePlan(object?.metadata?.plan);

    restaurant.billingProvider = "STRIPE";
    restaurant.billingStatus = "checkout_completed";
    restaurant.billingLastWebhookAt = new Date();

    if (object?.customer) {
      restaurant.billingCustomerId = String(object.customer);
    }

    if (object?.subscription) {
      restaurant.billingSubscriptionId = String(object.subscription);
    }

    if (["STARTER", "GROWTH", "PRO", "ENTERPRISE"].includes(plan)) {
      restaurant.subscriptionPlan = plan;
    }

    await restaurant.save();
    return;
  }

  if (
    eventType === "customer.subscription.created" ||
    eventType === "customer.subscription.updated" ||
    eventType === "customer.subscription.deleted"
  ) {
    const restaurant = await findRestaurantForStripeObject(object);
    if (!restaurant) {
      return;
    }

    applySubscriptionObjectToRestaurant(
      restaurant,
      object,
      normalizePlan(object?.metadata?.plan || restaurant.subscriptionPlan)
    );

    if (eventType === "customer.subscription.deleted") {
      restaurant.subscriptionPlan = "STARTER";
      restaurant.billingStatus = "canceled";
      restaurant.status = "SUSPENDED";
    }

    await restaurant.save();
    return;
  }

  if (eventType === "invoice.payment_failed") {
    const restaurant = await findRestaurantForStripeObject(object);
    if (!restaurant) {
      return;
    }

    restaurant.billingProvider = "STRIPE";
    restaurant.billingStatus = "payment_failed";
    restaurant.billingLastWebhookAt = new Date();

    if (object?.customer) {
      restaurant.billingCustomerId = String(object.customer);
    }

    if (object?.subscription) {
      restaurant.billingSubscriptionId = String(object.subscription);
    }

    restaurant.status = "SUSPENDED";
    await restaurant.save();
    return;
  }

  if (eventType === "invoice.paid" || eventType === "invoice.payment_succeeded") {
    const restaurant = await findRestaurantForStripeObject(object);
    if (!restaurant) {
      return;
    }

    const paidPeriodEnd = toDateFromUnix(object?.lines?.data?.[0]?.period?.end);

    restaurant.billingProvider = "STRIPE";
    restaurant.billingStatus = "active";
    restaurant.billingLastWebhookAt = new Date();
    restaurant.status = "ACTIVE";

    if (object?.customer) {
      restaurant.billingCustomerId = String(object.customer);
    }

    if (object?.subscription) {
      restaurant.billingSubscriptionId = String(object.subscription);
    }

    if (paidPeriodEnd) {
      restaurant.billingCurrentPeriodEnd = paidPeriodEnd;
      restaurant.subscriptionExpiry = paidPeriodEnd;
    }

    await restaurant.save();
  }
};

router.post("/", async (req, res) => {
  try {
    const signature = req.headers["stripe-signature"];
    const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || "").trim();

    if (!webhookSecret) {
      return res.status(500).json({ message: "Missing STRIPE_WEBHOOK_SECRET" });
    }

    const rawBody = req.body;
    const verified = verifyStripeWebhookSignature({
      rawBody,
      signatureHeader: signature,
      webhookSecret
    });

    if (!verified) {
      return res.status(400).json({ message: "Invalid Stripe signature" });
    }

    const event = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : "{}");
    const eventId = String(event?.id || "").trim();

    if (!eventId) {
      return res.status(400).json({ message: "Stripe event id is missing" });
    }

    const existingEvent = await ProcessedWebhookEvent.findOne({
      provider: "STRIPE",
      eventId
    }).lean();

    if (existingEvent) {
      return res.json({ received: true, duplicate: true });
    }

    await handleStripeEvent(event);
    await ProcessedWebhookEvent.create({
      provider: "STRIPE",
      eventId
    });

    return res.json({ received: true });
  } catch (err) {
    if (err?.code === 11000) {
      return res.json({ received: true, duplicate: true });
    }

    console.error("[billing] stripe webhook error", err.message);
    return res.status(500).json({ message: "Webhook handling failed" });
  }
});

module.exports = router;
