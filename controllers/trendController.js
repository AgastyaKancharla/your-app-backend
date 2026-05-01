const { getTenantRestaurantId } = require("../utils/tenantScope");
const Trend = require("../models/Trend");

const normalizeText = (value = "") => String(value || "").trim();
const uniqueStrings = (values = []) => {
  return Array.from(
    new Set(
      values
        .map((value) => normalizeText(value))
        .filter(Boolean)
    )
  );
};

const createTrend = async (req, res) => {
  try {
    const area = normalizeText(req.body?.area);
    const trendingItems = Array.isArray(req.body?.trendingItems)
      ? uniqueStrings(req.body.trendingItems)
      : [];

    if (!area) {
      return res.status(400).json({ message: "area is required" });
    }

    if (!trendingItems.length) {
      return res.status(400).json({ message: "trendingItems must be a non-empty array" });
    }

    const trend = await Trend.create({
      restaurantId: getTenantRestaurantId(req) || null,
      area,
      trendingItems
    });

    return res.status(201).json(trend);
  } catch (err) {
    return res.serverError(err);
  }
};

module.exports = {
  createTrend
};
