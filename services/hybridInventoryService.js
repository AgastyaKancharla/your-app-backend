const Restaurant = require("../models/Restaurant");
const RawMaterial = require("../models/RawMaterial");
const PrepItem = require("../models/PrepItem");
const Packaging = require("../models/Packaging");
const InventoryMovement = require("../models/InventoryMovement");
const Reconciliation = require("../models/Reconciliation");
const PurchaseOrder = require("../models/PurchaseOrder");
const SupplierPriceHistory = require("../models/SupplierPriceHistory");
const { convertBetweenUnits } = require("../utils/unitConversion");
const {
  createInventoryMovement,
  getItemModel,
  getStockField,
  getUnitCost,
  normalizeItemType,
  recordSupplierPrice,
  runInInventoryTransaction
} = require("./inventoryMovementService");
const {
  calculateRecipeCosting,
  findActiveRecipeVersion
} = require("./recipeEngineService");

const DEFAULT_SETTINGS = {
  mode: "STRICT",
  allowNegativeStock: false,
  requireOverrideReason: true,
  blockCriticalIngredientOnly: true,
  leadTimeDays: 2,
  safetyDays: 2
};

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeText = (value = "") => String(value || "").trim();

const getInventorySettings = async (restaurantId) => {
  const restaurant = await Restaurant.findById(restaurantId).select("inventorySettings").lean();
  return {
    ...DEFAULT_SETTINGS,
    ...(restaurant?.inventorySettings || {})
  };
};

const getAvailableStock = (item, itemType) => toNumber(item?.[getStockField(itemType)]);

const resolveStockItem = async ({ restaurantId, ingredientId, ingredientType }) => {
  const itemType = normalizeItemType(ingredientType);
  const Model = getItemModel(itemType);
  return Model.findOne({ restaurantId, _id: ingredientId });
};

const buildOrderInventoryPlan = async ({ restaurantId, orderItems = [] }) => {
  const requirementsByItem = new Map();
  const itemSnapshots = [];

  for (const orderItem of orderItems) {
    const recipeVersion = await findActiveRecipeVersion({
      restaurantId,
      menuItemId: orderItem.menuItemId || orderItem.menuId,
      variantId: orderItem.variantId || orderItem.variantName || orderItem.variant?.name,
      variantName: orderItem.variantName || orderItem.variant?.name
    });

    if (!recipeVersion) {
      itemSnapshots.push({
        menuItemId: orderItem.menuItemId || orderItem.menuId || null,
        recipeVersionId: null,
        costSnapshot: {
          recipeCost: toNumber(orderItem.costPrice ?? orderItem.cost),
          unitCost: toNumber(orderItem.costPrice ?? orderItem.cost),
          totalCost: toNumber(orderItem.costPrice ?? orderItem.cost) * toNumber(orderItem.quantity),
          ingredients: []
        }
      });
      continue;
    }

    const costing = await calculateRecipeCosting({ restaurantId, recipeVersion });
    const orderQty = Math.max(0, toNumber(orderItem.quantity, 1));
    itemSnapshots.push({
      menuItemId: orderItem.menuItemId || orderItem.menuId || null,
      recipeVersionId: recipeVersion._id,
      costSnapshot: {
        recipeCost: costing.totalCost,
        unitCost: costing.unitCost,
        totalCost: Number((costing.unitCost * orderQty).toFixed(4)),
        ingredients: costing.ingredients
      }
    });

    for (const ingredient of recipeVersion.ingredients || []) {
      const stockItem = await resolveStockItem({
        restaurantId,
        ingredientId: ingredient.ingredientId,
        ingredientType: ingredient.ingredientType
      });
      if (!stockItem) {
        continue;
      }

      const stockUnit = stockItem.unit || ingredient.unit || "unit";
      const converted = convertBetweenUnits(ingredient.quantity, ingredient.unit, stockUnit);
      const quantityPerOrder = Number.isFinite(converted) ? converted : toNumber(ingredient.quantity);
      const requiredQty = Number((quantityPerOrder * orderQty).toFixed(4));
      const key = `${ingredient.ingredientType}:${stockItem._id}`;
      const current = requirementsByItem.get(key) || {
        item: stockItem,
        itemId: stockItem._id,
        itemType: normalizeItemType(ingredient.ingredientType),
        itemName: stockItem.name || stockItem.itemName || ingredient.ingredientName,
        unit: stockUnit,
        required: 0,
        isCritical: Boolean(ingredient.isCritical),
        recipeVersionIds: new Set()
      };
      current.required = Number((current.required + requiredQty).toFixed(4));
      current.isCritical = current.isCritical || Boolean(ingredient.isCritical);
      current.recipeVersionIds.add(String(recipeVersion._id));
      requirementsByItem.set(key, current);
    }
  }

  return {
    requirements: Array.from(requirementsByItem.values()).map((entry) => ({
      ...entry,
      recipeVersionIds: Array.from(entry.recipeVersionIds)
    })),
    itemSnapshots
  };
};

const evaluateInventoryAvailability = async ({
  restaurantId,
  orderItems = [],
  overrideReason = "",
  userId = null
}) => {
  const settings = await getInventorySettings(restaurantId);
  const plan = await buildOrderInventoryPlan({ restaurantId, orderItems });
  const shortages = plan.requirements
    .map((requirement) => {
      const available = getAvailableStock(requirement.item, requirement.itemType);
      const shortageQty = Number((requirement.required - available).toFixed(4));
      return shortageQty > 0
        ? {
            itemId: requirement.itemId,
            itemType: requirement.itemType,
            itemName: requirement.itemName,
            required: requirement.required,
            available,
            shortageQty,
            unit: requirement.unit,
            isCritical: requirement.isCritical
          }
        : null;
    })
    .filter(Boolean);

  const blockingShortages = settings.blockCriticalIngredientOnly
    ? shortages.filter((shortage) => shortage.isCritical)
    : shortages;
  const manualMode = settings.mode === "MANUAL";
  const strictBlock = settings.mode === "STRICT" && blockingShortages.length > 0;
  const warningRequiresReason =
    settings.mode === "WARNING" &&
    settings.requireOverrideReason &&
    shortages.length > 0 &&
    !normalizeText(overrideReason);

  return {
    ...plan,
    settings,
    shortages,
    canProceed: manualMode || (!strictBlock && !warningRequiresReason),
    requiresOverride: settings.mode === "WARNING" && shortages.length > 0,
    override: shortages.length
      ? {
          reason: normalizeText(overrideReason),
          userId,
          timestamp: new Date(),
          shortages
        }
      : null
  };
};

const deductInventoryForOrder = async ({
  restaurantId,
  orderItems = [],
  orderId = null,
  createdBy = null,
  overrideReason = "",
  session = null
}) => {
  const evaluation = await evaluateInventoryAvailability({
    restaurantId,
    orderItems,
    overrideReason,
    userId: createdBy
  });

  if (!evaluation.canProceed) {
    const error = new Error(
      evaluation.requiresOverride
        ? "Inventory override reason is required"
        : "Insufficient stock for one or more ingredients"
    );
    error.status = evaluation.requiresOverride ? 400 : 409;
    error.shortages = evaluation.shortages;
    error.canProceed = false;
    throw error;
  }

  if (evaluation.settings.mode === "MANUAL") {
    return {
      deducted: [],
      shortages: evaluation.shortages,
      itemSnapshots: evaluation.itemSnapshots,
      override: evaluation.override
    };
  }

  const allowNegativeStock =
    evaluation.settings.allowNegativeStock || evaluation.settings.mode === "WARNING";
  const deducted = [];
  for (const requirement of evaluation.requirements) {
    const result = await createInventoryMovement({
      restaurantId,
      itemId: requirement.itemId,
      itemType: requirement.itemType,
      movementType: "order_deduction",
      quantity: requirement.required,
      unit: requirement.unit,
      costPerUnit: getUnitCost(requirement.item, requirement.itemType),
      referenceType: "order",
      referenceId: orderId,
      createdBy,
      notes: overrideReason ? `Override: ${overrideReason}` : "",
      metadata: {
        recipeVersionIds: requirement.recipeVersionIds,
        shortages: evaluation.shortages
      },
      allowNegativeStock,
      session
    });
    deducted.push({
      itemId: requirement.itemId,
      itemType: requirement.itemType,
      itemName: requirement.itemName,
      quantity: requirement.required,
      unit: requirement.unit,
      stock: result.stockAfter
    });
  }

  return {
    deducted,
    shortages: evaluation.shortages,
    itemSnapshots: evaluation.itemSnapshots,
    override: evaluation.override
  };
};

const producePrepItem = async ({
  restaurantId,
  payload = {},
  createdBy = null,
  session = null
}) =>
  runInInventoryTransaction(async (txnSession) => {
    const rawMaterialUsage = Array.isArray(payload.rawMaterialUsage) ? payload.rawMaterialUsage : [];
    const consumed = [];
    let totalCost = 0;

    for (const line of rawMaterialUsage) {
      const itemId = line.materialId || line.itemId || line.ingredientId;
      const raw = await RawMaterial.findOne({
        restaurantId,
        _id: itemId,
        stockCategory: "RAW_MATERIAL"
      }).session(txnSession);
      if (!raw) {
        const error = new Error("Raw material used in prep item was not found");
        error.status = 404;
        throw error;
      }

      const stockUnit = raw.unit || line.unit || "kg";
      const converted = convertBetweenUnits(toNumber(line.qty ?? line.quantity), line.unit || stockUnit, stockUnit);
      const qty = Number.isFinite(converted) ? converted : toNumber(line.qty ?? line.quantity);
      const unitCost = getUnitCost(raw, "raw_material");
      totalCost += qty * unitCost;
      await createInventoryMovement({
        restaurantId,
        itemId: raw._id,
        itemType: "raw_material",
        movementType: "prep_consumption",
        quantity: qty,
        unit: stockUnit,
        costPerUnit: unitCost,
        referenceType: "prep_batch",
        createdBy,
        notes: `Consumed for ${payload.name || "prep production"}`,
        session: txnSession
      });
      consumed.push({
        materialId: raw._id,
        materialName: raw.name,
        qty,
        unit: stockUnit
      });
    }

    const quantity = Math.max(0, toNumber(payload.quantity));
    const unitCost = quantity > 0 ? Number((totalCost / quantity).toFixed(4)) : 0;
    const created = await PrepItem.create(
      [
        {
          restaurantId,
          name: normalizeText(payload.name),
          batchNo: normalizeText(payload.batchNo) || `BATCH-${Date.now()}`,
          quantity: 0,
          unit: normalizeText(payload.unit) || "kg",
          cost: 0,
          preparedAt: payload.preparedAt ? new Date(payload.preparedAt) : new Date(),
          expiryAt: payload.expiryAt ? new Date(payload.expiryAt) : null,
          rawMaterialUsage: consumed,
          createdBy
        }
      ],
      { session: txnSession }
    );

    const movement = await createInventoryMovement({
      restaurantId,
      itemId: created[0]._id,
      itemType: "prep_item",
      movementType: "prep_production",
      quantity,
      unit: created[0].unit,
      costPerUnit: unitCost,
      referenceType: "prep_batch",
      referenceId: created[0]._id,
      createdBy,
      notes: "Prep production",
      session: txnSession
    });

    return {
      prepItem: movement.item,
      consumed
    };
  }, session);

const approveReconciliation = async ({ restaurantId, reconciliationId, approvedBy = null }) =>
  runInInventoryTransaction(async (session) => {
    const reconciliation = await Reconciliation.findOne({
      restaurantId,
      _id: reconciliationId
    }).session(session);
    if (!reconciliation) {
      const error = new Error("Reconciliation not found");
      error.status = 404;
      throw error;
    }
    if (reconciliation.status !== "pending") {
      const error = new Error("Only pending reconciliations can be approved");
      error.status = 400;
      throw error;
    }

    for (const item of reconciliation.items || []) {
      if (!toNumber(item.variance)) {
        continue;
      }
      await createInventoryMovement({
        restaurantId,
        itemId: item.itemId,
        itemType: item.itemType,
        movementType: "reconciliation_adjustment",
        quantity: item.variance,
        unit: item.unit,
        referenceType: "reconciliation",
        referenceId: reconciliation._id,
        createdBy: approvedBy,
        notes: "Daily reconciliation adjustment",
        allowNegativeStock: true,
        session
      });
    }

    reconciliation.status = "approved";
    reconciliation.approvedBy = approvedBy;
    reconciliation.approvedAt = new Date();
    await reconciliation.save({ session });
    return reconciliation;
  });

const receivePurchaseOrder = async ({
  restaurantId,
  purchaseOrderId,
  receivedItems = [],
  createdBy = null
}) =>
  runInInventoryTransaction(async (session) => {
    const purchaseOrder = await PurchaseOrder.findOne({ restaurantId, _id: purchaseOrderId }).session(session);
    if (!purchaseOrder) {
      const error = new Error("Purchase order not found");
      error.status = 404;
      throw error;
    }

    const poLines =
      Array.isArray(purchaseOrder.items) && purchaseOrder.items.length
        ? purchaseOrder.items
        : Array.isArray(purchaseOrder.lines)
          ? purchaseOrder.lines
          : [];
    const requestedByKey = new Map(
      (Array.isArray(receivedItems) && receivedItems.length ? receivedItems : poLines)
        .map((item) => [String(item.itemId || item.ingredientName || item.itemName), item])
    );
    const received = [];
    const nextLines = [];

    for (const line of poLines) {
      const key = String(line.itemId || line.ingredientName);
      const requested = requestedByKey.get(key);
      const quantity = Math.max(0, toNumber(requested?.quantity ?? requested?.qty ?? line.quantity));
      const alreadyReceived = toNumber(line.receivedQuantity);
      const remaining = Math.max(0, toNumber(line.quantity) - alreadyReceived);
      const receiveQty = Math.min(quantity, remaining || quantity);
      const itemType = normalizeItemType(line.type);
      let item = null;

      if (receiveQty > 0) {
        const Model = getItemModel(itemType);
        const filter = line.itemId
          ? { restaurantId, _id: line.itemId }
          : itemType === "raw_material"
            ? { restaurantId, name: line.ingredientName, stockCategory: "RAW_MATERIAL" }
            : { restaurantId, name: line.ingredientName };
        const insert = itemType === "raw_material"
          ? { restaurantId, name: line.ingredientName, minStock: 0, quantity: 0, stockCategory: "RAW_MATERIAL" }
          : itemType === "packaging"
            ? { restaurantId, name: line.ingredientName, minStock: 0, stock: 0 }
            : { restaurantId, name: line.ingredientName, batchNo: `PO-${purchaseOrder.poNumber}`, quantity: 0 };
        item = await Model.findOneAndUpdate(
          filter,
          {
            $setOnInsert: insert,
            $set: {
              unit: line.unit,
              supplierId: purchaseOrder.supplierId || null,
              supplierName: purchaseOrder.supplierName || "",
              supplier: purchaseOrder.supplierName || "",
              vendorName: purchaseOrder.supplierName || ""
            }
          },
          { upsert: true, new: true, session }
        );

        const movement = await createInventoryMovement({
          restaurantId,
          itemId: item._id,
          itemType,
          movementType: "purchase",
          quantity: receiveQty,
          unit: line.unit,
          costPerUnit: toNumber(line.unitPrice ?? line.cost),
          referenceType: "purchase_order",
          referenceId: purchaseOrder._id,
          createdBy,
          notes: `Received ${purchaseOrder.poNumber}`,
          session
        });
        await recordSupplierPrice({
          restaurantId,
          supplierId: purchaseOrder.supplierId || null,
          itemId: item._id,
          itemType,
          itemName: line.ingredientName,
          unit: line.unit,
          unitPrice: toNumber(line.unitPrice ?? line.cost),
          purchaseOrderId: purchaseOrder._id,
          session
        });
        received.push({
          itemId: item._id,
          itemType,
          itemName: line.ingredientName,
          quantity: receiveQty,
          unit: line.unit,
          stock: movement.stockAfter
        });
      }

      const plainLine = typeof line.toObject === "function" ? line.toObject() : line;
      nextLines.push({
        ...plainLine,
        receivedQuantity: Number((alreadyReceived + receiveQty).toFixed(4))
      });
    }

    purchaseOrder.items = nextLines;
    purchaseOrder.lines = nextLines;
    const allReceived = nextLines.every((line) => toNumber(line.receivedQuantity) >= toNumber(line.quantity));
    purchaseOrder.status = allReceived ? "DELIVERED" : "IN_TRANSIT";
    purchaseOrder.receivedAt = allReceived ? new Date() : purchaseOrder.receivedAt;
    await purchaseOrder.save({ session });

    return {
      purchaseOrder,
      received
    };
  });

const createStockAdjustment = ({
  restaurantId,
  itemId,
  itemType,
  quantity,
  unit,
  reason = "",
  createdBy = null
}) =>
  runInInventoryTransaction((session) =>
    createInventoryMovement({
      restaurantId,
      itemId,
      itemType,
      movementType: "adjustment",
      quantity,
      unit,
      referenceType: "adjustment",
      createdBy,
      notes: reason,
      allowNegativeStock: true,
      session
    })
  );

const getMovementHistory = async ({ restaurantId, query = {} }) => {
  const page = Math.max(1, Math.floor(toNumber(query.page, 1)));
  const limit = Math.min(100, Math.max(1, Math.floor(toNumber(query.limit, 50))));
  const filter = { restaurantId };
  if (query.itemId) filter.itemId = query.itemId;
  if (query.movementType) filter.movementType = query.movementType;
  if (query.itemType) filter.itemType = normalizeItemType(query.itemType);

  const [data, total] = await Promise.all([
    InventoryMovement.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    InventoryMovement.countDocuments(filter)
  ]);

  return {
    data,
    pagination: {
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit))
    }
  };
};

const getSupplierPriceHistory = ({ restaurantId, query = {} }) => {
  const filter = { restaurantId };
  if (query.supplierId) filter.supplierId = query.supplierId;
  if (query.itemId) filter.itemId = query.itemId;
  return SupplierPriceHistory.find(filter).sort({ createdAt: -1 }).limit(300).lean();
};

const getPurchaseSuggestions = async ({ restaurantId, leadTimeDays, safetyDays }) => {
  const settings = await getInventorySettings(restaurantId);
  const leadTime = toNumber(leadTimeDays, settings.leadTimeDays);
  const safety = toNumber(safetyDays, settings.safetyDays);
  const since = new Date();
  since.setDate(since.getDate() - 7);

  const usage = await InventoryMovement.aggregate([
    {
      $match: {
        restaurantId,
        movementType: { $in: ["order_deduction", "prep_consumption", "wastage"] },
        createdAt: { $gte: since }
      }
    },
    {
      $group: {
        _id: { itemId: "$itemId", itemType: "$itemType" },
        used: { $sum: { $abs: "$quantity" } }
      }
    }
  ]);

  const suggestions = [];
  for (const row of usage) {
    const Model = getItemModel(row._id.itemType);
    const item = await Model.findOne({ restaurantId, _id: row._id.itemId }).lean();
    if (!item) continue;
    const avgDailyUsage = toNumber(row.used) / 7;
    const required = avgDailyUsage * (leadTime + safety);
    const currentStock = getAvailableStock(item, row._id.itemType);
    const recommendedQuantity = Math.max(0, Number((required - currentStock).toFixed(4)));
    if (recommendedQuantity > 0) {
      suggestions.push({
        itemId: item._id,
        itemType: row._id.itemType,
        itemName: item.name || item.itemName,
        unit: item.unit || "unit",
        avgDailyUsage: Number(avgDailyUsage.toFixed(4)),
        currentStock,
        required: Number(required.toFixed(4)),
        recommendedQuantity,
        supplierId: item.supplierId || null
      });
    }
  }

  return suggestions;
};

module.exports = {
  approveReconciliation,
  buildOrderInventoryPlan,
  createStockAdjustment,
  deductInventoryForOrder,
  evaluateInventoryAvailability,
  getInventorySettings,
  getMovementHistory,
  getPurchaseSuggestions,
  getSupplierPriceHistory,
  producePrepItem,
  receivePurchaseOrder
};
