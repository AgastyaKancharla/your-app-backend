const mongoose = require("mongoose");

const InventoryMovement = require("../models/InventoryMovement");
const RawMaterial = require("../models/RawMaterial");
const PrepItem = require("../models/PrepItem");
const Packaging = require("../models/Packaging");
const SupplierPriceHistory = require("../models/SupplierPriceHistory");
const { isBelowMinStock } = require("../utils/unitConversion");

const ITEM_TYPE_TO_MODEL = {
  raw_material: RawMaterial,
  prep_item: PrepItem,
  packaging: Packaging
};

const STOCK_FIELD_BY_TYPE = {
  raw_material: "quantity",
  prep_item: "quantity",
  packaging: "stock"
};

const SIGN_BY_MOVEMENT = {
  purchase: 1,
  order_deduction: -1,
  wastage: -1,
  adjustment: 1,
  prep_consumption: -1,
  prep_production: 1,
  reconciliation_adjustment: 1
};

const MOVEMENT_TYPES = Object.freeze(Object.keys(SIGN_BY_MOVEMENT));

const normalizeItemType = (value = "raw_material") => {
  const normalized = String(value || "").trim().toLowerCase();
  if (["raw", "ingredient", "raw_material", "raw-material"].includes(normalized)) {
    return "raw_material";
  }
  if (["prep", "prep_item", "prep-item"].includes(normalized)) {
    return "prep_item";
  }
  if (normalized === "packaging") {
    return "packaging";
  }
  return "raw_material";
};

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const getItemModel = (itemType) => ITEM_TYPE_TO_MODEL[normalizeItemType(itemType)] || RawMaterial;

const getStockField = (itemType) => STOCK_FIELD_BY_TYPE[normalizeItemType(itemType)] || "quantity";

const getStockValue = (item = {}, itemType = "raw_material") =>
  toNumber(item?.[getStockField(itemType)]);

const getUnitCost = (item = {}, itemType = "raw_material") => {
  const normalized = normalizeItemType(itemType);
  if (normalized === "packaging") {
    return toNumber(item.costPerUnit);
  }
  if (normalized === "prep_item") {
    const quantity = Math.max(1, toNumber(item.quantity));
    return toNumber(item.cost) / quantity;
  }
  return toNumber(item.costPerUnit ?? item.pricePerUnit ?? item.purchasePrice);
};

const syncAliasesForUpdate = ({ itemType, nextStock, item, costPerUnit }) => {
  const normalized = normalizeItemType(itemType);
  if (normalized === "packaging") {
    return {
      stock: nextStock,
      costPerUnit: costPerUnit === undefined ? item.costPerUnit : costPerUnit
    };
  }

  const update = {
    quantity: nextStock,
    currentStock: nextStock,
    stock: nextStock
  };

  if (normalized === "raw_material") {
    update.itemName = item.name || item.itemName || "";
    update.threshold = item.minStock || 0;
    update.lowStockAlert = isBelowMinStock({
      quantity: nextStock,
      unit: item.unit,
      minStock: item.minStock,
      minStockUnit: item.minStockUnit
    });
    if (costPerUnit !== undefined) {
      update.costPerUnit = costPerUnit;
      update.pricePerUnit = costPerUnit;
      update.purchasePrice = costPerUnit;
    }
  }

  if (normalized === "prep_item" && costPerUnit !== undefined) {
    update.cost = Number((nextStock * costPerUnit).toFixed(4));
  }

  return update;
};

const calculateWeightedAverageCost = ({ existingQuantity, existingCost, incomingQuantity, incomingCost }) => {
  const currentQty = Math.max(0, toNumber(existingQuantity));
  const incomingQty = Math.max(0, toNumber(incomingQuantity));
  const totalQty = currentQty + incomingQty;
  if (totalQty <= 0) {
    return Math.max(0, toNumber(incomingCost, existingCost));
  }

  const currentValue = currentQty * Math.max(0, toNumber(existingCost));
  const incomingValue = incomingQty * Math.max(0, toNumber(incomingCost));
  return Number(((currentValue + incomingValue) / totalQty).toFixed(4));
};

const createInventoryMovement = async ({
  restaurantId,
  itemId,
  itemType,
  movementType,
  quantity,
  unit,
  costPerUnit,
  referenceType = "",
  referenceId = null,
  createdBy = null,
  notes = "",
  metadata = {},
  allowNegativeStock = false,
  session = null
}) => {
  const normalizedType = normalizeItemType(itemType);
  if (!MOVEMENT_TYPES.includes(movementType)) {
    const error = new Error("Invalid inventory movement type");
    error.status = 400;
    throw error;
  }

  const Model = getItemModel(normalizedType);
  const stockField = getStockField(normalizedType);
  const item = await Model.findOne({ restaurantId, _id: itemId }).session(session);
  if (!item) {
    const error = new Error("Inventory item not found");
    error.status = 404;
    throw error;
  }

  const requestedQuantity = toNumber(quantity);
  if (!requestedQuantity) {
    const error = new Error("Movement quantity must be non-zero");
    error.status = 400;
    throw error;
  }

  const sign = SIGN_BY_MOVEMENT[movementType] || 1;
  const signedQuantity = movementType === "adjustment" || movementType === "reconciliation_adjustment"
    ? requestedQuantity
    : Math.abs(requestedQuantity) * sign;
  const stockBefore = toNumber(item[stockField]);
  const stockAfter = Number((stockBefore + signedQuantity).toFixed(4));

  if (!allowNegativeStock && stockAfter < 0) {
    const error = new Error(`Insufficient stock for ${item.name || item.itemName}.`);
    error.status = 409;
    throw error;
  }

  const previousCost = getUnitCost(item, normalizedType);
  const nextCost =
    movementType === "purchase" || movementType === "prep_production"
      ? calculateWeightedAverageCost({
          existingQuantity: stockBefore,
          existingCost: previousCost,
          incomingQuantity: Math.abs(signedQuantity),
          incomingCost: toNumber(costPerUnit, previousCost)
        })
      : toNumber(costPerUnit, previousCost);

  const movement = await InventoryMovement.create(
    [
      {
        restaurantId,
        itemId: item._id,
        itemType: normalizedType,
        movementType,
        quantity: signedQuantity,
        unit: unit || item.unit || "unit",
        costPerUnit: nextCost,
        totalCost: Math.abs(signedQuantity) * nextCost,
        referenceType,
        referenceId,
        createdBy,
        notes,
        stockBefore,
        stockAfter,
        metadata
      }
    ],
    { session }
  );

  item.set(syncAliasesForUpdate({
    itemType: normalizedType,
    nextStock: stockAfter,
    item,
    costPerUnit:
      movementType === "purchase" || movementType === "prep_production" ? nextCost : undefined
  }));
  await item.save({ session });

  return {
    movement: movement[0],
    item,
    stockBefore,
    stockAfter,
    costPerUnit: nextCost
  };
};

const serializeStockItem = (item = {}, itemType = "raw_material") => {
  const normalizedType = normalizeItemType(itemType);
  const stock = getStockValue(item, normalizedType);
  const costPerUnit = getUnitCost(item, normalizedType);
  const minStock = normalizedType === "packaging"
    ? toNumber(item.minStock)
    : toNumber(item.minStock ?? item.minStockAlert);

  return {
    itemId: item._id,
    itemType: normalizedType,
    itemName: item.name || item.itemName || "",
    unit: item.unit || "unit",
    stock,
    minStock,
    costPerUnit,
    stockValue: Number((stock * costPerUnit).toFixed(2)),
    lowStock: stock <= minStock,
    negativeStock: stock < 0
  };
};

const getStockSummary = async ({ restaurantId, query = {} }) => {
  const normalizedType = query.itemType ? normalizeItemType(query.itemType) : "";
  const since = query.from ? new Date(query.from) : null;
  const until = query.to ? new Date(query.to) : null;
  const movementMatch = { restaurantId };
  if (normalizedType) movementMatch.itemType = normalizedType;
  if (since || until) {
    movementMatch.createdAt = {};
    if (since && !Number.isNaN(since.getTime())) movementMatch.createdAt.$gte = since;
    if (until && !Number.isNaN(until.getTime())) movementMatch.createdAt.$lte = until;
    if (!Object.keys(movementMatch.createdAt).length) delete movementMatch.createdAt;
  }

  const [rawMaterials, prepItems, packagingItems, movementTotals] = await Promise.all([
    normalizedType && normalizedType !== "raw_material"
      ? []
      : RawMaterial.find({ restaurantId, stockCategory: "RAW_MATERIAL" }).lean(),
    normalizedType && normalizedType !== "prep_item"
      ? []
      : PrepItem.find({ restaurantId }).lean(),
    normalizedType && normalizedType !== "packaging"
      ? []
      : Packaging.find({ restaurantId }).lean(),
    InventoryMovement.aggregate([
      { $match: movementMatch },
      {
        $group: {
          _id: { itemType: "$itemType", movementType: "$movementType" },
          quantity: { $sum: "$quantity" },
          absoluteQuantity: { $sum: { $abs: "$quantity" } },
          totalCost: { $sum: "$totalCost" },
          count: { $sum: 1 }
        }
      },
      {
        $group: {
          _id: "$_id.itemType",
          movements: {
            $push: {
              movementType: "$_id.movementType",
              quantity: "$quantity",
              absoluteQuantity: "$absoluteQuantity",
              totalCost: "$totalCost",
              count: "$count"
            }
          },
          count: { $sum: "$count" }
        }
      }
    ])
  ]);

  const items = [
    ...rawMaterials.map((item) => serializeStockItem(item, "raw_material")),
    ...prepItems.map((item) => serializeStockItem(item, "prep_item")),
    ...packagingItems.map((item) => serializeStockItem(item, "packaging"))
  ];

  const byType = items.reduce((acc, item) => {
    const current = acc[item.itemType] || {
      itemType: item.itemType,
      itemCount: 0,
      stockValue: 0,
      lowStock: 0,
      negativeStock: 0
    };
    current.itemCount += 1;
    current.stockValue += item.stockValue;
    current.lowStock += item.lowStock ? 1 : 0;
    current.negativeStock += item.negativeStock ? 1 : 0;
    acc[item.itemType] = current;
    return acc;
  }, {});

  movementTotals.forEach((row) => {
    const itemType = row._id || "raw_material";
    byType[itemType] = byType[itemType] || {
      itemType,
      itemCount: 0,
      stockValue: 0,
      lowStock: 0,
      negativeStock: 0
    };
    byType[itemType].movementCount = row.count;
    byType[itemType].movements = row.movements;
  });

  Object.values(byType).forEach((row) => {
    row.stockValue = Number(toNumber(row.stockValue).toFixed(2));
    row.movementCount = toNumber(row.movementCount);
    row.movements = row.movements || [];
  });

  const totals = items.reduce(
    (acc, item) => {
      acc.itemCount += 1;
      acc.stockValue += item.stockValue;
      acc.lowStock += item.lowStock ? 1 : 0;
      acc.negativeStock += item.negativeStock ? 1 : 0;
      return acc;
    },
    { itemCount: 0, stockValue: 0, lowStock: 0, negativeStock: 0 }
  );
  totals.stockValue = Number(totals.stockValue.toFixed(2));

  return {
    totals,
    byType: Object.values(byType),
    items
  };
};

const runInInventoryTransaction = async (callback, existingSession = null) => {
  if (existingSession) {
    return callback(existingSession);
  }

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await callback(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
};

const recordSupplierPrice = async ({
  restaurantId,
  supplierId = null,
  itemId = null,
  itemType,
  itemName = "",
  unit = "unit",
  unitPrice = 0,
  purchaseOrderId = null,
  session = null
}) => {
  return SupplierPriceHistory.create(
    [
      {
        restaurantId,
        supplierId,
        itemId,
        itemType: normalizeItemType(itemType),
        itemName,
        unit,
        unitPrice,
        purchaseOrderId,
        receivedAt: new Date()
      }
    ],
    { session }
  );
};

module.exports = {
  calculateWeightedAverageCost,
  createInventoryMovement,
  getItemModel,
  getStockField,
  getStockSummary,
  getUnitCost,
  normalizeItemType,
  recordSupplierPrice,
  runInInventoryTransaction
};
