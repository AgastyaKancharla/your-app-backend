const express = require("express");
const mongoose = require("mongoose");

const Restaurant = require("../models/Restaurant");
const { createOrderRecord, normalizeOrderChannel, serializeOrder } = require("../services/orderCreationService");

const router = express.Router();

const CHANNEL_CONFIG_MAP = {
  WEBSITE: "website",
  SWIGGY: "swiggy",
  ZOMATO: "zomato",
  MAGICPIN: "magicpin",
  OTHER_APP: "otherApps"
};

const isDbConnected = () => mongoose.connection.readyState === 1;

const getIntegrationKey = (req) =>
  String(req.get("x-crm-integration-key") || req.body?.integrationKey || "").trim();

const isChannelEnabled = (restaurant, channel) => {
  const configKey = CHANNEL_CONFIG_MAP[channel];
  if (!configKey) {
    return false;
  }

  return Boolean(restaurant?.orderIntegrations?.[configKey]?.enabled);
};

router.post("/", async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({
        message: "Database connection is not ready. Please retry in a moment."
      });
    }

    const integrationKey = getIntegrationKey(req);
    if (!integrationKey) {
      return res.status(401).json({ message: "Integration key is required" });
    }

    const channel = normalizeOrderChannel(req.body?.channel || req.body?.orderChannel);
    if (!CHANNEL_CONFIG_MAP[channel]) {
      return res.status(400).json({
        message: "Use WEBSITE, SWIGGY, ZOMATO, MAGICPIN, or OTHER_APP channel"
      });
    }

    const restaurant = await Restaurant.findOne({
      integrationApiKey: integrationKey,
      status: "ACTIVE"
    });

    if (!restaurant) {
      return res.status(401).json({ message: "Invalid integration key" });
    }

    if (!isChannelEnabled(restaurant, channel)) {
      return res.status(403).json({
        message: `${channel} integration is not enabled for this restaurant`
      });
    }

    const { order, created } = await createOrderRecord({
      restaurantId: restaurant._id,
      payload: req.body,
      requestedChannel: channel,
      integrationMeta: {
        sourceLabel: req.body?.sourceLabel || channel,
        origin: req.get("origin") || req.ip || "",
        websiteUrl: restaurant.websiteUrl || "",
        storeId: restaurant.orderIntegrations?.[CHANNEL_CONFIG_MAP[channel]]?.storeId || "",
        notes: restaurant.orderIntegrations?.[CHANNEL_CONFIG_MAP[channel]]?.notes || ""
      }
    });

    return res.status(created ? 201 : 200).json({
      created,
      order: serializeOrder(order)
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ message: err.message });
    }
    return res.serverError(err);
  }
});

module.exports = router;
