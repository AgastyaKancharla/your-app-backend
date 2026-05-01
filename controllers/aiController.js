const mongoose = require("mongoose");

const AIInsight = require("../models/AIInsight");
const { generateSalesInsights } = require("../services/aiService");
const { sendCampaign } = require("../services/campaignService");
const { handleOwnerQuery } = require("../services/ownerChatService");
const { getTenantRestaurantId } = require("../utils/tenantScope");

const normalizeText = (value = "") => String(value || "").trim();

const resolveRestaurantId = (req, value) => {
  const restaurantId = normalizeText(value);
  if (!mongoose.Types.ObjectId.isValid(restaurantId)) {
    const error = new Error("Valid restaurantId is required");
    error.status = 400;
    throw error;
  }

  const tenantRestaurantId = getTenantRestaurantId(req);
  if (!tenantRestaurantId || String(tenantRestaurantId) !== restaurantId) {
    const error = new Error("Forbidden: restaurant access denied");
    error.status = 403;
    throw error;
  }

  return restaurantId;
};

const generateInsights = async (req, res) => {
  try {
    const restaurantId = resolveRestaurantId(req, req.params.restaurantId);
    const insight = await generateSalesInsights(restaurantId);
    return res.status(201).json(insight);
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({ message: err.message });
    }
    return res.serverError(err);
  }
};

const getLatestInsights = async (req, res) => {
  try {
    const restaurantId = resolveRestaurantId(req, req.params.restaurantId);
    const latestInsight = await AIInsight.findOne({ restaurantId }).sort({ createdAt: -1 });

    if (!latestInsight) {
      return res.status(404).json({ message: "AI insight not found" });
    }

    return res.json(latestInsight);
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({ message: err.message });
    }
    return res.serverError(err);
  }
};

const chatWithOwner = async (req, res) => {
  try {
    const restaurantId = resolveRestaurantId(req, req.body?.restaurantId);
    const question = normalizeText(req.body?.question);
    if (!question) {
      return res.status(400).json({ message: "question is required" });
    }

    const answer = await handleOwnerQuery(restaurantId, question);
    return res.json({ answer });
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({ message: err.message });
    }
    return res.serverError(err);
  }
};

const executeAiCampaign = async (req, res) => {
  try {
    const restaurantId = resolveRestaurantId(req, req.params.restaurantId);
    const result = await sendCampaign(restaurantId, {
      createdBy: req.user?.userId || null
    });

    return res.json(result);
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({ message: err.message });
    }
    return res.serverError(err);
  }
};

module.exports = {
  chatWithOwner,
  executeAiCampaign,
  generateInsights,
  getLatestInsights
};
