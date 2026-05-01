const Restaurant = require("../models/Restaurant");
const Order = require("../models/Order");
const Customer = require("../models/Customer");
const MenuItem = require("../models/MenuItem");
const Trend = require("../models/Trend");
const AIInsight = require("../models/AIInsight");

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || "gpt-4o-mini").trim() || "gpt-4o-mini";
const ORDERS_LIMIT = 50;

const normalizeText = (value = "") => String(value || "").trim();
const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const uniqueStrings = (values = []) => {
  return Array.from(
    new Set(
      values
        .map((value) => normalizeText(value))
        .filter(Boolean)
    )
  );
};

const createStatusError = (status, message) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

const getOpenAiApiKey = () => {
  const apiKey = normalizeText(process.env.OPENAI_API_KEY);
  if (!apiKey) {
    throw createStatusError(500, "OPENAI_API_KEY is not configured");
  }

  return apiKey;
};

const parseJsonFromContent = (content = "") => {
  const normalizedContent = normalizeText(content);
  if (!normalizedContent) {
    return {};
  }

  try {
    return JSON.parse(normalizedContent);
  } catch {
    const match = normalizedContent.match(/\{[\s\S]*\}/);
    if (!match) {
      throw createStatusError(502, "OpenAI returned invalid JSON");
    }

    return JSON.parse(match[0]);
  }
};

const callOpenAiChat = async ({ systemPrompt, userPrompt, responseFormat = null, temperature = 0.3 }) => {
  const apiKey = getOpenAiApiKey();

  if (typeof fetch !== "function") {
    throw createStatusError(500, "Global fetch is not available in this Node runtime");
  }

  const body = {
    model: OPENAI_MODEL,
    temperature,
    messages: [
      {
        role: "system",
        content: systemPrompt
      },
      {
        role: "user",
        content: userPrompt
      }
    ]
  };

  if (responseFormat) {
    body.response_format = responseFormat;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const raw = await response.text();
    let parsed = {};
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = { raw };
      }
    }

    if (!response.ok) {
      throw createStatusError(
        response.status,
        normalizeText(parsed?.error?.message || parsed?.raw || "OpenAI request failed")
      );
    }

    const content = normalizeText(parsed?.choices?.[0]?.message?.content);
    if (!content) {
      throw createStatusError(502, "OpenAI returned an empty response");
    }

    return content;
  } finally {
    clearTimeout(timeout);
  }
};

const callOpenAiJson = async ({ systemPrompt, payload }) => {
  const content = await callOpenAiChat({
    systemPrompt,
    userPrompt: JSON.stringify(payload, null, 2),
    responseFormat: { type: "json_object" },
    temperature: 0.2
  });

  return parseJsonFromContent(content);
};

const normalizeInsightPayload = (payload = {}) => {
  const readArray = (...keys) => {
    for (const key of keys) {
      if (Array.isArray(payload?.[key])) {
        return uniqueStrings(payload[key]);
      }
    }

    return [];
  };

  return {
    whatToSell: readArray("what_to_sell", "whatToSell"),
    menuImprovements: readArray("menu_improvements", "menuImprovements"),
    pricingStrategy: readArray("pricing_strategy", "pricingStrategy"),
    marketingIdeas: readArray("marketing_ideas", "marketingIdeas"),
    campaignMessage: normalizeText(payload?.campaign_message || payload?.campaignMessage)
  };
};

const buildItemSummary = (orders = []) => {
  const itemMap = new Map();
  let totalRevenue = 0;

  orders.forEach((order) => {
    totalRevenue += toNumber(order?.grandTotal ?? order?.totalAmount);

    (order?.items || []).forEach((item) => {
      const name = normalizeText(item?.displayName || item?.name);
      if (!name) {
        return;
      }

      const quantity = Math.max(0, toNumber(item?.quantity));
      const unitPrice = Math.max(0, toNumber(item?.price));
      const existing = itemMap.get(name) || { name, quantity: 0, revenue: 0 };

      existing.quantity += quantity;
      existing.revenue += quantity * unitPrice;
      itemMap.set(name, existing);
    });
  });

  const rankedItems = Array.from(itemMap.values()).sort((a, b) => {
    if (b.quantity !== a.quantity) {
      return b.quantity - a.quantity;
    }

    return b.revenue - a.revenue;
  });

  const totalOrders = orders.length;
  const averageOrderValue = totalOrders ? totalRevenue / totalOrders : 0;

  return {
    topItems: rankedItems.slice(0, 5),
    lowItems: [...rankedItems]
      .sort((a, b) => {
        if (a.quantity !== b.quantity) {
          return a.quantity - b.quantity;
        }

        return a.revenue - b.revenue;
      })
      .slice(0, 5),
    totalOrders,
    totalRevenue: Number(totalRevenue.toFixed(2)),
    averageOrderValue: Number(averageOrderValue.toFixed(2))
  };
};

const deriveRestaurantLocation = (restaurant) => {
  return (
    normalizeText(restaurant?.location) ||
    normalizeText([restaurant?.address, restaurant?.city].filter(Boolean).join(", ")) ||
    normalizeText(restaurant?.city)
  );
};

const computeAverageMenuPrice = (restaurant, menuItems = []) => {
  const explicitAverage = toNumber(restaurant?.avgPrice, 0);
  if (explicitAverage > 0) {
    return explicitAverage;
  }

  if (!menuItems.length) {
    return 0;
  }

  const sum = menuItems.reduce((total, item) => total + toNumber(item?.sellingPrice ?? item?.price), 0);
  return Number((sum / menuItems.length).toFixed(2));
};

const buildAnalysisContext = async (restaurantId) => {
  const restaurant = await Restaurant.findById(restaurantId);
  if (!restaurant) {
    throw createStatusError(404, "Restaurant not found");
  }

  const area = deriveRestaurantLocation(restaurant);
  const [orders, menuItems, trendDocs, totalCustomers, repeatCustomers, highValueCustomers] = await Promise.all([
    Order.find({ restaurantId }).sort({ createdAt: -1 }).limit(ORDERS_LIMIT),
    MenuItem.find({ restaurantId }).sort({ category: 1, name: 1 }).limit(100),
    area ? Trend.find({ area }).sort({ createdAt: -1 }).limit(5) : [],
    Customer.countDocuments({ restaurantId }),
    Customer.countDocuments({
      restaurantId,
      $or: [{ totalOrders: { $gte: 2 } }, { orderCount: { $gte: 2 } }]
    }),
    Customer.countDocuments({
      restaurantId,
      $or: [{ totalSpent: { $gte: 3000 } }, { lifetimeValue: { $gte: 3000 } }]
    })
  ]);

  const salesSummary = buildItemSummary(orders);
  const menuCatalog = uniqueStrings([
    ...(Array.isArray(restaurant?.menu) ? restaurant.menu : []),
    ...menuItems.map((item) => item?.name)
  ]).slice(0, 100);
  const flattenedTrendItems = uniqueStrings(
    trendDocs.flatMap((trend) => trend?.trendingItems || [])
  ).slice(0, 20);

  return {
    restaurant,
    context: {
      restaurant: {
        id: String(restaurant._id),
        name: normalizeText(restaurant.restaurantName || restaurant.name),
        location: area,
        audienceType: normalizeText(restaurant?.audienceType),
        avgPrice: computeAverageMenuPrice(restaurant, menuItems),
        menu: menuCatalog
      },
      sales: salesSummary,
      customers: {
        totalCustomers,
        repeatCustomers,
        highValueCustomers
      },
      trends: {
        area,
        trendingItems: flattenedTrendItems
      }
    }
  };
};

const generateSalesInsights = async (restaurantId) => {
  const { context } = await buildAnalysisContext(restaurantId);

  const aiPayload = {
    restaurant: context.restaurant,
    sales_summary: context.sales,
    customer_summary: context.customers,
    trend_summary: context.trends,
    instructions: {
      focus: [
        "what to sell today",
        "menu improvements",
        "pricing strategy",
        "marketing ideas",
        "one strong WhatsApp campaign message"
      ],
      output_contract: {
        what_to_sell: ["string"],
        menu_improvements: ["string"],
        pricing_strategy: ["string"],
        marketing_ideas: ["string"],
        campaign_message: "string"
      }
    }
  };

  const rawInsights = await callOpenAiJson({
    systemPrompt:
      "You are a restaurant business consultant. Give practical, actionable advice to increase sales. Respond with valid JSON only.",
    payload: aiPayload
  });

  const normalizedInsights = normalizeInsightPayload(rawInsights);
  const savedInsight = await AIInsight.create({
    restaurantId,
    whatToSell: normalizedInsights.whatToSell,
    menuImprovements: normalizedInsights.menuImprovements,
    pricingStrategy: normalizedInsights.pricingStrategy,
    marketingIdeas: normalizedInsights.marketingIdeas,
    campaignMessage: normalizedInsights.campaignMessage
  });

  return savedInsight;
};

module.exports = {
  buildAnalysisContext,
  buildItemSummary,
  callOpenAiChat,
  generateSalesInsights,
  normalizeInsightPayload
};
