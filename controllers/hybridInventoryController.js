const Reconciliation = require("../models/Reconciliation");
const Restaurant = require("../models/Restaurant");
const RawMaterial = require("../models/RawMaterial");
const PrepItem = require("../models/PrepItem");
const Packaging = require("../models/Packaging");
const RecipeVersion = require("../models/RecipeVersion");
const {
  approveReconciliation,
  createStockAdjustment,
  getInventorySettings,
  getMovementHistory,
  getPurchaseSuggestions,
  getSupplierPriceHistory,
  producePrepItem,
  receivePurchaseOrder
} = require("../services/hybridInventoryService");
const {
  calculateRecipeCosting,
  createRecipeVersion
} = require("../services/recipeEngineService");
const {
  acknowledgeInventoryAlert,
  listInventoryAlerts
} = require("../services/inventoryAlertService");
const { getStockSummary } = require("../services/inventoryMovementService");
const { assertCloudKitchenWorkspace } = require("../utils/cloudKitchenWorkspace");
const { getTenantRestaurantId, withTenantFilter } = require("../utils/tenantScope");

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const assertCloud = async (req) => {
  await assertCloudKitchenWorkspace(req);
  const restaurantId = getTenantRestaurantId(req);
  if (!restaurantId) {
    const error = new Error("Tenant context is required");
    error.status = 401;
    throw error;
  }
  return restaurantId;
};

const getStockSnapshotItems = async (restaurantId) => {
  const [rawMaterials, prepItems, packagingItems] = await Promise.all([
    RawMaterial.find({ restaurantId, stockCategory: "RAW_MATERIAL" }).lean(),
    PrepItem.find({ restaurantId }).lean(),
    Packaging.find({ restaurantId }).lean()
  ]);

  return [
    ...rawMaterials.map((item) => ({
      itemId: item._id,
      itemType: "raw_material",
      itemName: item.name || item.itemName,
      unit: item.unit || "kg",
      expectedQty: toNumber(item.quantity)
    })),
    ...prepItems.map((item) => ({
      itemId: item._id,
      itemType: "prep_item",
      itemName: item.name,
      unit: item.unit || "kg",
      expectedQty: toNumber(item.quantity)
    })),
    ...packagingItems.map((item) => ({
      itemId: item._id,
      itemType: "packaging",
      itemName: item.name,
      unit: item.unit || "pcs",
      expectedQty: toNumber(item.stock)
    }))
  ];
};

const createRecipe = async (req, res) => {
  try {
    const restaurantId = await assertCloud(req);
    const version = await createRecipeVersion({
      restaurantId,
      ...req.body,
      createdBy: req.user?.userId || null
    });
    return res.status(201).json(version);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const listRecipeVersions = async (req, res) => {
  try {
    const restaurantId = await assertCloud(req);
    const versions = await RecipeVersion.find({ restaurantId })
      .sort({ updatedAt: -1, version: -1 })
      .limit(300)
      .lean();
    const rows = await Promise.all(
      versions.map(async (version) => ({
        ...version,
        costing: await calculateRecipeCosting({ restaurantId, recipeVersion: version })
      }))
    );
    return res.json({ data: rows });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const versionRecipe = async (req, res) => {
  try {
    const restaurantId = await assertCloud(req);
    const version = await createRecipeVersion({
      restaurantId,
      ...req.body,
      menuItemId: req.body?.menuItemId,
      createdBy: req.user?.userId || null
    });
    return res.status(201).json(version);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const getRecipeCosting = async (req, res) => {
  try {
    const restaurantId = await assertCloud(req);
    const recipeVersion = await RecipeVersion.findOne({
      restaurantId,
      _id: req.params.versionId
    });
    if (!recipeVersion) return res.status(404).json({ message: "Recipe version not found" });
    return res.json(await calculateRecipeCosting({ restaurantId, recipeVersion }));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const getRecipeUsage = async (req, res) => {
  try {
    const restaurantId = await assertCloud(req);
    const movements = await getMovementHistory({
      restaurantId,
      query: {
        movementType: "order_deduction",
        limit: req.query.limit || 100
      }
    });
    return res.json(movements);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const getMovements = async (req, res) => {
  try {
    const restaurantId = await assertCloud(req);
    return res.json(await getMovementHistory({ restaurantId, query: req.query }));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const getMovementSummary = async (req, res) => {
  try {
    const restaurantId = await assertCloud(req);
    return res.json(await getStockSummary({ restaurantId, query: req.query }));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const createAdjustment = async (req, res) => {
  try {
    const restaurantId = await assertCloud(req);
    const result = await createStockAdjustment({
      restaurantId,
      itemId: req.body?.itemId,
      itemType: req.body?.itemType,
      quantity: req.body?.quantity,
      unit: req.body?.unit,
      reason: req.body?.reason,
      createdBy: req.user?.userId || null
    });
    return res.status(201).json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const createPrepProduction = async (req, res) => {
  try {
    const restaurantId = await assertCloud(req);
    const result = await producePrepItem({
      restaurantId,
      payload: req.body,
      createdBy: req.user?.userId || null
    });
    return res.status(201).json(result.prepItem);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const createReconciliation = async (req, res) => {
  try {
    const restaurantId = await assertCloud(req);
    const snapshotItems = await getStockSnapshotItems(restaurantId);
    const countByKey = new Map(
      (Array.isArray(req.body?.items) ? req.body.items : []).map((item) => [
        `${item.itemType}:${item.itemId}`,
        item
      ])
    );
    const items = snapshotItems.map((item) => {
      const counted = countByKey.get(`${item.itemType}:${item.itemId}`);
      return {
        ...item,
        countedQty: counted ? toNumber(counted.countedQty ?? counted.quantity) : null,
        notes: counted?.notes || ""
      };
    });
    const created = await Reconciliation.create({
      restaurantId,
      date: req.body?.date ? new Date(req.body.date) : new Date(),
      items,
      status: "pending",
      notes: req.body?.notes || "",
      createdBy: req.user?.userId || null
    });
    return res.status(201).json(created);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const listReconciliations = async (req, res) => {
  try {
    await assertCloud(req);
    const filter = withTenantFilter(req);
    if (req.query.status) filter.status = req.query.status;
    const rows = await Reconciliation.find(filter).sort({ date: -1 }).limit(200).lean();
    const blind = String(req.query.blind || "").toLowerCase() === "true";
    return res.json(
      blind
        ? rows.map((row) => ({
            ...row,
            items: row.items.map(({ expectedQty, variance, ...item }) => item)
          }))
        : rows
    );
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const approveReconciliationRequest = async (req, res) => {
  try {
    const restaurantId = await assertCloud(req);
    const result = await approveReconciliation({
      restaurantId,
      reconciliationId: req.params.id,
      approvedBy: req.user?.userId || null
    });
    return res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const rejectReconciliation = async (req, res) => {
  try {
    await assertCloud(req);
    const updated = await Reconciliation.findOneAndUpdate(
      withTenantFilter(req, { _id: req.params.id, status: "pending" }),
      {
        status: "rejected",
        rejectedBy: req.user?.userId || null,
        rejectedAt: new Date()
      },
      { new: true }
    );
    if (!updated) return res.status(404).json({ message: "Pending reconciliation not found" });
    return res.json(updated);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const receivePO = async (req, res) => {
  try {
    const restaurantId = await assertCloud(req);
    const result = await receivePurchaseOrder({
      restaurantId,
      purchaseOrderId: req.params.id,
      receivedItems: req.body?.items || req.body?.receivedItems || [],
      createdBy: req.user?.userId || null
    });
    return res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const priceHistory = async (req, res) => {
  try {
    const restaurantId = await assertCloud(req);
    return res.json(await getSupplierPriceHistory({ restaurantId, query: req.query }));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const listAlerts = async (req, res) => {
  try {
    const restaurantId = await assertCloud(req);
    return res.json({ alerts: await listInventoryAlerts({ restaurantId, query: req.query }) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const acknowledgeAlert = async (req, res) => {
  try {
    const restaurantId = await assertCloud(req);
    const alert = await acknowledgeInventoryAlert({
      restaurantId,
      alertId: req.params.id,
      userId: req.user?.userId || null
    });
    if (!alert) return res.status(404).json({ message: "Alert not found" });
    return res.json(alert);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const stockAnalytics = async (req, res) => {
  try {
    const restaurantId = await assertCloud(req);
    const [rawMaterials, prepItems, packagingItems, settings] = await Promise.all([
      RawMaterial.find({ restaurantId, stockCategory: "RAW_MATERIAL" }).lean(),
      PrepItem.find({ restaurantId }).lean(),
      Packaging.find({ restaurantId }).lean(),
      getInventorySettings(restaurantId)
    ]);
    const rawValue = rawMaterials.reduce(
      (sum, item) => sum + toNumber(item.quantity) * toNumber(item.costPerUnit ?? item.pricePerUnit),
      0
    );
    const prepValue = prepItems.reduce((sum, item) => sum + toNumber(item.cost), 0);
    const packagingValue = packagingItems.reduce(
      (sum, item) => sum + toNumber(item.stock) * toNumber(item.costPerUnit),
      0
    );
    return res.json({
      settings,
      totals: {
        rawMaterials: rawMaterials.length,
        prepItems: prepItems.length,
        packagingItems: packagingItems.length,
        stockValue: Number((rawValue + prepValue + packagingValue).toFixed(2))
      },
      lowStock: rawMaterials.filter((item) => toNumber(item.quantity) <= toNumber(item.minStock)).length +
        packagingItems.filter((item) => toNumber(item.stock) <= toNumber(item.minStock)).length,
      negativeStock: rawMaterials.filter((item) => toNumber(item.quantity) < 0).length +
        packagingItems.filter((item) => toNumber(item.stock) < 0).length
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const updateInventorySettings = async (req, res) => {
  try {
    const restaurantId = await assertCloud(req);
    const mode = String(req.body?.mode || "").trim().toUpperCase();
    const patch = {};
    if (["STRICT", "WARNING", "MANUAL"].includes(mode)) patch.mode = mode;
    ["allowNegativeStock", "requireOverrideReason", "blockCriticalIngredientOnly"].forEach((field) => {
      if (req.body?.[field] !== undefined) patch[field] = Boolean(req.body[field]);
    });
    ["leadTimeDays", "safetyDays"].forEach((field) => {
      if (req.body?.[field] !== undefined) patch[field] = Math.max(0, toNumber(req.body[field]));
    });

    const $set = Object.entries(patch).reduce((acc, [key, value]) => {
      acc[`inventorySettings.${key}`] = value;
      return acc;
    }, {});

    if (!Object.keys($set).length) {
      return res.status(400).json({ message: "No valid inventory settings supplied" });
    }

    const restaurant = await Restaurant.findByIdAndUpdate(
      restaurantId,
      { $set },
      { new: true }
    ).select("inventorySettings");
    return res.json(restaurant?.inventorySettings || {});
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const purchaseSuggestions = async (req, res) => {
  try {
    const restaurantId = await assertCloud(req);
    const suggestions = await getPurchaseSuggestions({
      restaurantId,
      leadTimeDays: req.query.leadTimeDays,
      safetyDays: req.query.safetyDays
    });
    return res.json({ suggestions });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

module.exports = {
  acknowledgeAlert,
  approveReconciliationRequest,
  createAdjustment,
  createPrepProduction,
  createRecipe,
  createReconciliation,
  getMovementSummary,
  getMovements,
  getRecipeCosting,
  getRecipeUsage,
  listAlerts,
  listRecipeVersions,
  listReconciliations,
  priceHistory,
  purchaseSuggestions,
  receivePO,
  rejectReconciliation,
  stockAnalytics,
  updateInventorySettings,
  versionRecipe
};
