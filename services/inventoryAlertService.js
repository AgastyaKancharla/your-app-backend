const RawMaterial = require("../models/RawMaterial");
const PrepItem = require("../models/PrepItem");
const Packaging = require("../models/Packaging");
const InventoryAlert = require("../models/InventoryAlert");
const InventoryMovement = require("../models/InventoryMovement");
const Reconciliation = require("../models/Reconciliation");

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const upsertGeneratedAlert = async (alert) => {
  const key = {
    restaurantId: alert.restaurantId,
    type: alert.type,
    itemId: alert.itemId || null,
    acknowledged: false
  };

  return InventoryAlert.findOneAndUpdate(
    key,
    {
      $set: {
        ...alert,
        acknowledged: false
      }
    },
    { upsert: true, new: true }
  );
};

const generateInventoryAlerts = async ({ restaurantId }) => {
  const alerts = [];
  const [rawMaterials, prepItems, packagingItems] = await Promise.all([
    RawMaterial.find({ restaurantId, stockCategory: "RAW_MATERIAL" }).lean(),
    PrepItem.find({ restaurantId }).lean(),
    Packaging.find({ restaurantId }).lean()
  ]);

  for (const item of rawMaterials) {
    const stock = toNumber(item.quantity);
    const minStock = toNumber(item.minStock);
    if (stock < 0) {
      alerts.push(await upsertGeneratedAlert({
        restaurantId,
        type: "negative_stock",
        severity: "critical",
        itemId: item._id,
        itemType: "raw_material",
        title: `${item.name} has negative stock`,
        message: `Current stock is ${stock} ${item.unit || "unit"}.`,
        metadata: { stock, minStock }
      }));
    } else if (stock <= 0 || stock <= minStock * 0.5) {
      alerts.push(await upsertGeneratedAlert({
        restaurantId,
        type: "critical_low_stock",
        severity: "critical",
        itemId: item._id,
        itemType: "raw_material",
        title: `${item.name} is critically low`,
        message: `Current stock is ${stock} ${item.unit || "unit"}.`,
        metadata: { stock, minStock }
      }));
    } else if (stock <= minStock) {
      alerts.push(await upsertGeneratedAlert({
        restaurantId,
        type: "low_stock",
        severity: "warning",
        itemId: item._id,
        itemType: "raw_material",
        title: `${item.name} is low`,
        message: `Current stock is ${stock} ${item.unit || "unit"}.`,
        metadata: { stock, minStock }
      }));
    }

    if (item.expiryDate) {
      const expiresInMs = new Date(item.expiryDate).getTime() - Date.now();
      if (expiresInMs > 0 && expiresInMs <= 72 * 60 * 60 * 1000) {
        alerts.push(await upsertGeneratedAlert({
          restaurantId,
          type: "expiring_soon",
          severity: "warning",
          itemId: item._id,
          itemType: "raw_material",
          title: `${item.name} expires soon`,
          message: "Use or review this item before expiry.",
          metadata: { expiryDate: item.expiryDate }
        }));
      }
    }
  }

  for (const item of packagingItems) {
    const stock = toNumber(item.stock);
    const minStock = toNumber(item.minStock);
    if (stock < 0 || stock <= minStock) {
      alerts.push(await upsertGeneratedAlert({
        restaurantId,
        type: stock < 0 ? "negative_stock" : "low_stock",
        severity: stock < 0 ? "critical" : "warning",
        itemId: item._id,
        itemType: "packaging",
        title: `${item.name} needs attention`,
        message: `Current stock is ${stock} ${item.unit || "unit"}.`,
        metadata: { stock, minStock }
      }));
    }
  }

  for (const item of prepItems) {
    if (!item.expiryAt) continue;
    const expiresInMs = new Date(item.expiryAt).getTime() - Date.now();
    if (expiresInMs > 0 && expiresInMs <= 72 * 60 * 60 * 1000) {
      alerts.push(await upsertGeneratedAlert({
        restaurantId,
        type: "expiring_soon",
        severity: "warning",
        itemId: item._id,
        itemType: "prep_item",
        title: `${item.name} batch expires soon`,
        message: "Review this prep batch before use.",
        metadata: { expiryAt: item.expiryAt, batchNo: item.batchNo }
      }));
    }
  }

  const since = new Date();
  since.setDate(since.getDate() - 7);
  const [wastage, overrides, variances] = await Promise.all([
    InventoryMovement.aggregate([
      { $match: { restaurantId, movementType: "wastage", createdAt: { $gte: since } } },
      { $group: { _id: "$itemId", total: { $sum: { $abs: "$quantity" } } } },
      { $match: { total: { $gt: 10 } } }
    ]),
    InventoryMovement.aggregate([
      {
        $match: {
          restaurantId,
          movementType: "order_deduction",
          "metadata.shortages.0": { $exists: true },
          createdAt: { $gte: since }
        }
      },
      { $group: { _id: null, count: { $sum: 1 } } }
    ]),
    Reconciliation.find({
      restaurantId,
      status: "approved",
      "items.variance": { $ne: 0 },
      approvedAt: { $gte: since }
    }).lean()
  ]);

  if (wastage.length) {
    alerts.push(await upsertGeneratedAlert({
      restaurantId,
      type: "excessive_wastage",
      severity: "warning",
      title: "Wastage is above normal",
      message: "Review recent wastage entries.",
      metadata: { items: wastage }
    }));
  }

  if (toNumber(overrides[0]?.count) >= 5) {
    alerts.push(await upsertGeneratedAlert({
      restaurantId,
      type: "excessive_overrides",
      severity: "warning",
      title: "Inventory overrides are frequent",
      message: "Review stock settings and recipe quantities.",
      metadata: { count: overrides[0].count }
    }));
  }

  if (variances.length) {
    alerts.push(await upsertGeneratedAlert({
      restaurantId,
      type: "abnormal_variance",
      severity: "warning",
      title: "Recent stock counts have variance",
      message: "Review approved reconciliations.",
      metadata: { reconciliationCount: variances.length }
    }));
  }

  return alerts.filter(Boolean);
};

const listInventoryAlerts = async ({ restaurantId, query = {} }) => {
  await generateInventoryAlerts({ restaurantId });
  const filter = { restaurantId };
  if (String(query.acknowledged || "").toLowerCase() === "false") {
    filter.acknowledged = false;
  }
  if (query.type) {
    filter.type = query.type;
  }
  return InventoryAlert.find(filter).sort({ acknowledged: 1, createdAt: -1 }).limit(300).lean();
};

const acknowledgeInventoryAlert = async ({ restaurantId, alertId, userId = null }) => {
  return InventoryAlert.findOneAndUpdate(
    { restaurantId, _id: alertId },
    {
      acknowledged: true,
      acknowledgedBy: userId,
      acknowledgedAt: new Date()
    },
    { new: true }
  );
};

module.exports = {
  acknowledgeInventoryAlert,
  generateInventoryAlerts,
  listInventoryAlerts
};
