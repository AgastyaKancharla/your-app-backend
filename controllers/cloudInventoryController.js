const mongoose = require("mongoose");

const RawMaterial = require("../models/RawMaterial");
const PrepItem = require("../models/PrepItem");
const Packaging = require("../models/Packaging");
const Wastage = require("../models/Wastage");
const Supplier = require("../models/Supplier");
const PurchaseOrder = require("../models/PurchaseOrder");
const Order = require("../models/Order");
const { syncMenuAvailability } = require("../services/cloudKitchenOperationsService");
const { assertCloudKitchenWorkspace } = require("../utils/cloudKitchenWorkspace");
const {
  getTenantRestaurantId,
  withTenantFilter,
  withTenantDocFilter
} = require("../utils/tenantScope");
const { convertBetweenUnits, isBelowMinStock, normalizeUnit } = require("../utils/unitConversion");

const EXPIRING_SOON_HOURS = 72;
const PO_STATUSES = ["OPEN", "CONFIRMED", "IN_TRANSIT", "DELIVERED", "CANCELLED"];

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const cleanText = (value = "") => String(value || "").trim();
const escapeRegex = (value = "") => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const startOfDay = (value = new Date()) => {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
};

const endOfDay = (value = new Date()) => {
  const date = new Date(value);
  date.setHours(23, 59, 59, 999);
  return date;
};

const addDays = (days) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
};

const getPagination = (query = {}) => {
  const page = Math.max(1, Math.floor(toNumber(query.page, 1)));
  const limit = Math.min(100, Math.max(1, Math.floor(toNumber(query.limit, 50))));
  return {
    page,
    limit,
    skip: (page - 1) * limit
  };
};

const paginateRows = (rows = [], query = {}) => {
  const { page, limit, skip } = getPagination(query);
  return {
    data: rows.slice(skip, skip + limit),
    pagination: {
      page,
      limit,
      total: rows.length,
      pages: Math.max(1, Math.ceil(rows.length / limit))
    }
  };
};

const buildSearchFilter = (query = {}, fields = ["name", "category"]) => {
  const search = cleanText(query.search);
  if (!search) {
    return {};
  }

  return {
    $or: fields.map((field) => ({
      [field]: { $regex: new RegExp(escapeRegex(search), "i") }
    }))
  };
};

const getStockStatus = ({ currentStock, minStock }) => {
  if (toNumber(currentStock) <= 0) {
    return "OUT_OF_STOCK";
  }
  if (toNumber(currentStock) <= toNumber(minStock)) {
    return "LOW_STOCK";
  }
  return "IN_STOCK";
};

const getExpiryStatus = (dateValue) => {
  if (!dateValue) {
    return "NONE";
  }

  const expiryTime = new Date(dateValue).getTime();
  if (!Number.isFinite(expiryTime)) {
    return "NONE";
  }

  const now = Date.now();
  if (expiryTime < now) {
    return "EXPIRED";
  }

  if (expiryTime <= now + EXPIRING_SOON_HOURS * 60 * 60 * 1000) {
    return "EXPIRING_SOON";
  }

  return "FRESH";
};

const getSupplierMap = async (restaurantId, supplierIds = []) => {
  const ids = supplierIds
    .map((value) => String(value || "").trim())
    .filter((value) => mongoose.Types.ObjectId.isValid(value));

  if (!ids.length) {
    return new Map();
  }

  const suppliers = await Supplier.find({ restaurantId, _id: { $in: ids } }).lean();
  return new Map(suppliers.map((supplier) => [String(supplier._id), supplier]));
};

const emitInventoryUpdate = (req, payload = {}) => {
  const ordersIo = req.app.get("ordersIo");
  const restaurantId = getTenantRestaurantId(req);
  if (!ordersIo || !restaurantId) {
    return;
  }

  ordersIo.to(`tenant:${restaurantId}`).emit("inventory:update", {
    ...payload,
    restaurantId: String(restaurantId),
    updatedAt: new Date().toISOString()
  });
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

const normalizeRawPayload = (body = {}) => {
  const currentStock = Math.max(0, toNumber(body.currentStock ?? body.quantity ?? body.stock));
  const costPerUnit = Math.max(0, toNumber(body.costPerUnit ?? body.pricePerUnit));
  const unit = normalizeUnit(body.unit || "kg") || "kg";

  return {
    name: cleanText(body.name || body.itemName),
    itemName: cleanText(body.itemName || body.name),
    category: cleanText(body.category) || "General",
    unit,
    quantity: currentStock,
    currentStock,
    stock: currentStock,
    minStock: Math.max(0, toNumber(body.minStock ?? body.minStockAlert)),
    minStockAlert: Math.max(0, toNumber(body.minStock ?? body.minStockAlert)),
    minStockUnit: normalizeUnit(body.minStockUnit || unit) || unit,
    costPerUnit,
    pricePerUnit: costPerUnit,
    purchasePrice: costPerUnit,
    supplierId: body.supplierId || null,
    supplier: cleanText(body.supplierName || body.supplier),
    vendorName: cleanText(body.supplierName || body.vendorName || body.supplier),
    expiryDate: body.expiryDate ? new Date(body.expiryDate) : null,
    image: cleanText(body.image),
    stockCategory: "RAW_MATERIAL"
  };
};

const serializeRawMaterial = (item, supplierMap = new Map()) => {
  const plain = item && typeof item.toObject === "function" ? item.toObject() : { ...(item || {}) };
  const supplier = plain.supplierId ? supplierMap.get(String(plain.supplierId)) : null;
  const currentStock = toNumber(plain.quantity ?? plain.currentStock);
  const minStock = toNumber(plain.minStock ?? plain.minStockAlert);
  const costPerUnit = toNumber(plain.costPerUnit ?? plain.pricePerUnit);

  return {
    _id: plain._id,
    name: plain.name || plain.itemName || "",
    image: plain.image || "",
    category: plain.category || "General",
    unit: plain.unit || "kg",
    currentStock,
    quantity: currentStock,
    minStock,
    costPerUnit,
    pricePerUnit: costPerUnit,
    supplierId: plain.supplierId || null,
    supplierName: supplier?.name || plain.supplier || plain.vendorName || "",
    expiryDate: plain.expiryDate || null,
    stockValue: Number((currentStock * costPerUnit).toFixed(2)),
    status: getStockStatus({ currentStock, minStock }),
    expiryStatus: getExpiryStatus(plain.expiryDate),
    createdAt: plain.createdAt
  };
};

const serializePrepItem = (item) => {
  const plain = item && typeof item.toObject === "function" ? item.toObject() : { ...(item || {}) };
  return {
    ...plain,
    status: plain.status || getPrepStatus(plain),
    expiryStatus: getExpiryStatus(plain.expiryAt),
    stockValue: toNumber(plain.cost)
  };
};

const serializePackaging = (item, supplierMap = new Map()) => {
  const plain = item && typeof item.toObject === "function" ? item.toObject() : { ...(item || {}) };
  const supplier = plain.supplierId ? supplierMap.get(String(plain.supplierId)) : null;
  const stock = toNumber(plain.stock);
  const minStock = toNumber(plain.minStock);
  const costPerUnit = toNumber(plain.costPerUnit);

  return {
    ...plain,
    supplierName: supplier?.name || plain.supplierName || "",
    stock,
    minStock,
    costPerUnit,
    stockValue: Number((stock * costPerUnit).toFixed(2)),
    status: getStockStatus({ currentStock: stock, minStock })
  };
};

const getPrepStatus = (item = {}) => {
  if (item.expiryAt && new Date(item.expiryAt).getTime() < Date.now()) {
    return "EXPIRED";
  }
  if (toNumber(item.quantity) <= 0) {
    return "CONSUMED";
  }
  return item.status || "ACTIVE";
};

const filterByDerivedStatus = (rows = [], status = "") => {
  const normalized = cleanText(status).toUpperCase();
  if (!normalized || normalized === "ALL") {
    return rows;
  }
  return rows.filter((row) => String(row.status || "").toUpperCase() === normalized);
};

const getRawMaterials = async (req, res) => {
  try {
    const restaurantId = await assertCloud(req);
    const filter = withTenantFilter(req, {
      stockCategory: "RAW_MATERIAL",
      ...buildSearchFilter(req.query, ["name", "category", "supplier", "vendorName"])
    });

    const category = cleanText(req.query.category);
    if (category && category.toUpperCase() !== "ALL") {
      filter.category = { $regex: new RegExp(`^${escapeRegex(category)}$`, "i") };
    }

    const materials = await RawMaterial.find(filter).sort({ name: 1 });
    const supplierMap = await getSupplierMap(
      restaurantId,
      materials.map((item) => item.supplierId)
    );
    const rows = filterByDerivedStatus(
      materials.map((item) => serializeRawMaterial(item, supplierMap)),
      req.query.status
    );
    const today = startOfDay();
    const todayWastage = await Wastage.find(
      withTenantFilter(req, {
        type: "raw",
        createdAt: { $gte: today, $lte: endOfDay() }
      })
    ).lean();
    const metrics = {
      totalItems: rows.length,
      totalStockValue: Number(rows.reduce((sum, item) => sum + item.stockValue, 0).toFixed(2)),
      lowStockItems: rows.filter((item) => item.status === "LOW_STOCK").length,
      expiringSoon: rows.filter((item) => item.expiryStatus === "EXPIRING_SOON").length,
      todayConsumption: Number(
        todayWastage.reduce((sum, entry) => sum + toNumber(entry.quantity), 0).toFixed(2)
      )
    };

    return res.json({
      ...paginateRows(rows, req.query),
      metrics
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const createRawMaterial = async (req, res) => {
  try {
    const restaurantId = await assertCloud(req);
    const payload = normalizeRawPayload(req.body);
    if (!payload.name) {
      return res.status(400).json({ message: "Raw material name is required" });
    }

    if (payload.supplierId) {
      const supplier = await Supplier.findOne({ restaurantId, _id: payload.supplierId }).lean();
      payload.supplier = supplier?.name || payload.supplier;
      payload.vendorName = supplier?.name || payload.vendorName;
    }

    payload.lowStockAlert = isBelowMinStock({
      quantity: payload.currentStock,
      unit: payload.unit,
      minStock: payload.minStock,
      minStockUnit: payload.minStockUnit
    });

    const created = await RawMaterial.create({ restaurantId, ...payload });
    await syncMenuAvailability(restaurantId);
    emitInventoryUpdate(req, { scope: "raw", action: "created", itemId: created._id });
    return res.status(201).json(serializeRawMaterial(created));
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ message: "Raw material already exists" });
    }
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const updateRawMaterial = async (req, res) => {
  try {
    const restaurantId = await assertCloud(req);
    const payload = normalizeRawPayload(req.body);
    if (!payload.name) {
      return res.status(400).json({ message: "Raw material name is required" });
    }

    if (payload.supplierId) {
      const supplier = await Supplier.findOne({ restaurantId, _id: payload.supplierId }).lean();
      payload.supplier = supplier?.name || payload.supplier;
      payload.vendorName = supplier?.name || payload.vendorName;
    }

    payload.lowStockAlert = isBelowMinStock({
      quantity: payload.currentStock,
      unit: payload.unit,
      minStock: payload.minStock,
      minStockUnit: payload.minStockUnit
    });

    const updated = await RawMaterial.findOneAndUpdate(
      withTenantDocFilter(req, req.params.id, { stockCategory: "RAW_MATERIAL" }),
      payload,
      { new: true, runValidators: true }
    );
    if (!updated) {
      return res.status(404).json({ message: "Raw material not found" });
    }

    await syncMenuAvailability(restaurantId);
    emitInventoryUpdate(req, { scope: "raw", action: "updated", itemId: updated._id });
    return res.json(serializeRawMaterial(updated));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const deleteRawMaterial = async (req, res) => {
  try {
    const restaurantId = await assertCloud(req);
    const deleted = await RawMaterial.findOneAndDelete(
      withTenantDocFilter(req, req.params.id, { stockCategory: "RAW_MATERIAL" })
    );
    if (!deleted) {
      return res.status(404).json({ message: "Raw material not found" });
    }
    await syncMenuAvailability(restaurantId);
    emitInventoryUpdate(req, { scope: "raw", action: "deleted", itemId: req.params.id });
    return res.json({ message: "Raw material deleted" });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const normalizeUsage = (usage = []) =>
  Array.isArray(usage)
    ? usage
        .map((line) => ({
          materialId: cleanText(line.materialId),
          qty: Math.max(0, toNumber(line.qty ?? line.quantity)),
          unit: normalizeUnit(line.unit || "kg") || "kg"
        }))
        .filter((line) => line.materialId && line.qty > 0)
    : [];

const validateAndDeductRawUsage = async ({ req, restaurantId, rawMaterialUsage }) => {
  const materialIds = rawMaterialUsage.map((line) => line.materialId);
  const materials = await RawMaterial.find({
    restaurantId,
    _id: { $in: materialIds },
    stockCategory: "RAW_MATERIAL"
  });
  const materialMap = new Map(materials.map((item) => [String(item._id), item]));

  rawMaterialUsage.forEach((line) => {
    const material = materialMap.get(String(line.materialId));
    if (!material) {
      const error = new Error("Raw material used in prep item was not found");
      error.status = 404;
      throw error;
    }

    const materialUnit = normalizeUnit(material.unit || line.unit || "kg") || "kg";
    const convertedQty = convertBetweenUnits(line.qty, line.unit, materialUnit);
    const deductionQty = Number.isFinite(convertedQty) ? convertedQty : line.qty;

    if (toNumber(material.quantity) < deductionQty) {
      const error = new Error(
        `Insufficient stock for ${material.name}. Required ${deductionQty} ${materialUnit}, available ${material.quantity} ${materialUnit}.`
      );
      error.status = 409;
      throw error;
    }
  });

  for (const line of rawMaterialUsage) {
    const material = materialMap.get(String(line.materialId));
    const materialUnit = normalizeUnit(material.unit || line.unit || "kg") || "kg";
    const convertedQty = convertBetweenUnits(line.qty, line.unit, materialUnit);
    const deductionQty = Number.isFinite(convertedQty) ? convertedQty : line.qty;
    material.quantity = Number((toNumber(material.quantity) - deductionQty).toFixed(4));
    material.currentStock = material.quantity;
    material.lowStockAlert = isBelowMinStock({
      quantity: material.quantity,
      unit: material.unit,
      minStock: material.minStock,
      minStockUnit: material.minStockUnit
    });
    await material.save();
  }

  await syncMenuAvailability(restaurantId);
  emitInventoryUpdate(req, { scope: "raw", action: "deducted" });

  return rawMaterialUsage.map((line) => {
    const material = materialMap.get(String(line.materialId));
    return {
      materialId: material._id,
      materialName: material.name,
      qty: line.qty,
      unit: line.unit
    };
  });
};

const normalizePrepPayload = (body = {}) => ({
  name: cleanText(body.name),
  batchNo: cleanText(body.batchNo) || `BATCH-${Date.now()}`,
  quantity: Math.max(0, toNumber(body.quantity)),
  unit: normalizeUnit(body.unit || "kg") || "kg",
  cost: Math.max(0, toNumber(body.cost)),
  preparedAt: body.preparedAt ? new Date(body.preparedAt) : new Date(),
  expiryAt: body.expiryAt ? new Date(body.expiryAt) : null,
  status: cleanText(body.status || "ACTIVE").toUpperCase(),
  rawMaterialUsage: normalizeUsage(body.rawMaterialUsage)
});

const getPrepItems = async (req, res) => {
  try {
    await assertCloud(req);
    const filter = withTenantFilter(req, buildSearchFilter(req.query, ["name", "batchNo", "status"]));
    const status = cleanText(req.query.status).toUpperCase();
    if (status && status !== "ALL") {
      filter.status = status;
    }

    const rows = (await PrepItem.find(filter).sort({ createdAt: -1 })).map(serializePrepItem);
    const today = new Date();
    const metrics = {
      totalPrepItems: rows.length,
      totalValue: Number(rows.reduce((sum, item) => sum + toNumber(item.cost), 0).toFixed(2)),
      expiringToday: rows.filter((item) => {
        if (!item.expiryAt) return false;
        const expiry = new Date(item.expiryAt);
        return expiry >= startOfDay(today) && expiry <= endOfDay(today);
      }).length,
      expiringSoon: rows.filter((item) => item.expiryStatus === "EXPIRING_SOON").length,
      totalBatches: new Set(rows.map((item) => item.batchNo)).size
    };

    return res.json({ ...paginateRows(rows, req.query), metrics });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const createPrepItem = async (req, res) => {
  try {
    const restaurantId = await assertCloud(req);
    const payload = normalizePrepPayload(req.body);
    if (!payload.name) return res.status(400).json({ message: "Prep item name is required" });
    if (payload.quantity <= 0) return res.status(400).json({ message: "Quantity must be greater than zero" });

    const usage = await validateAndDeductRawUsage({
      req,
      restaurantId,
      rawMaterialUsage: payload.rawMaterialUsage
    });
    const created = await PrepItem.create({
      restaurantId,
      ...payload,
      rawMaterialUsage: usage,
      createdBy: req.user?.userId || null
    });

    emitInventoryUpdate(req, { scope: "prep", action: "created", itemId: created._id });
    return res.status(201).json(serializePrepItem(created));
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ message: "Batch number already exists" });
    }
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const updatePrepItem = async (req, res) => {
  try {
    await assertCloud(req);
    const payload = normalizePrepPayload(req.body);
    if (!payload.name) return res.status(400).json({ message: "Prep item name is required" });

    const updated = await PrepItem.findOneAndUpdate(withTenantDocFilter(req, req.params.id), payload, {
      new: true,
      runValidators: true
    });
    if (!updated) return res.status(404).json({ message: "Prep item not found" });

    emitInventoryUpdate(req, { scope: "prep", action: "updated", itemId: updated._id });
    return res.json(serializePrepItem(updated));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const deletePrepItem = async (req, res) => {
  try {
    await assertCloud(req);
    const deleted = await PrepItem.findOneAndDelete(withTenantDocFilter(req, req.params.id));
    if (!deleted) return res.status(404).json({ message: "Prep item not found" });
    emitInventoryUpdate(req, { scope: "prep", action: "deleted", itemId: req.params.id });
    return res.json({ message: "Prep item deleted" });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const normalizePackagingPayload = (body = {}) => ({
  name: cleanText(body.name),
  category: cleanText(body.category) || "Packaging",
  unit: normalizeUnit(body.unit || "pcs") || "pcs",
  stock: Math.max(0, toNumber(body.stock ?? body.currentStock)),
  minStock: Math.max(0, toNumber(body.minStock)),
  costPerUnit: Math.max(0, toNumber(body.costPerUnit)),
  supplierId: body.supplierId || null,
  supplierName: cleanText(body.supplierName),
  image: cleanText(body.image)
});

const getPackagingItems = async (req, res) => {
  try {
    const restaurantId = await assertCloud(req);
    const filter = withTenantFilter(req, buildSearchFilter(req.query, ["name", "category", "supplierName"]));
    const items = await Packaging.find(filter).sort({ name: 1 });
    const supplierMap = await getSupplierMap(restaurantId, items.map((item) => item.supplierId));
    const rows = filterByDerivedStatus(
      items.map((item) => serializePackaging(item, supplierMap)),
      req.query.status
    );
    const todayWastage = await Wastage.find(
      withTenantFilter(req, {
        type: "packaging",
        createdAt: { $gte: startOfDay(), $lte: endOfDay() }
      })
    ).lean();
    const metrics = {
      totalItems: rows.length,
      stockValue: Number(rows.reduce((sum, item) => sum + item.stockValue, 0).toFixed(2)),
      lowStock: rows.filter((item) => item.status === "LOW_STOCK").length,
      outOfStock: rows.filter((item) => item.status === "OUT_OF_STOCK").length,
      dailyUsage: Number(todayWastage.reduce((sum, entry) => sum + toNumber(entry.quantity), 0).toFixed(2))
    };

    return res.json({ ...paginateRows(rows, req.query), metrics });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const createPackagingItem = async (req, res) => {
  try {
    const restaurantId = await assertCloud(req);
    const payload = normalizePackagingPayload(req.body);
    if (!payload.name) return res.status(400).json({ message: "Packaging name is required" });

    if (payload.supplierId) {
      const supplier = await Supplier.findOne({ restaurantId, _id: payload.supplierId }).lean();
      payload.supplierName = supplier?.name || payload.supplierName;
    }

    const created = await Packaging.create({ restaurantId, ...payload });
    emitInventoryUpdate(req, { scope: "packaging", action: "created", itemId: created._id });
    return res.status(201).json(serializePackaging(created));
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ message: "Packaging item already exists" });
    }
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const updatePackagingItem = async (req, res) => {
  try {
    const restaurantId = await assertCloud(req);
    const payload = normalizePackagingPayload(req.body);
    if (!payload.name) return res.status(400).json({ message: "Packaging name is required" });

    if (payload.supplierId) {
      const supplier = await Supplier.findOne({ restaurantId, _id: payload.supplierId }).lean();
      payload.supplierName = supplier?.name || payload.supplierName;
    }

    const updated = await Packaging.findOneAndUpdate(withTenantDocFilter(req, req.params.id), payload, {
      new: true,
      runValidators: true
    });
    if (!updated) return res.status(404).json({ message: "Packaging item not found" });

    emitInventoryUpdate(req, { scope: "packaging", action: "updated", itemId: updated._id });
    return res.json(serializePackaging(updated));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const deletePackagingItem = async (req, res) => {
  try {
    await assertCloud(req);
    const deleted = await Packaging.findOneAndDelete(withTenantDocFilter(req, req.params.id));
    if (!deleted) return res.status(404).json({ message: "Packaging item not found" });
    emitInventoryUpdate(req, { scope: "packaging", action: "deleted", itemId: req.params.id });
    return res.json({ message: "Packaging item deleted" });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const findWastageItem = async (req, type, itemId) => {
  if (type === "prep") {
    return PrepItem.findOne(withTenantDocFilter(req, itemId));
  }
  if (type === "packaging") {
    return Packaging.findOne(withTenantDocFilter(req, itemId));
  }
  return RawMaterial.findOne(withTenantDocFilter(req, itemId, { stockCategory: "RAW_MATERIAL" }));
};

const deductWastageStock = async ({ req, item, type, quantity }) => {
  if (!item) {
    const error = new Error("Wastage item not found");
    error.status = 404;
    throw error;
  }

  const stockField = type === "packaging" ? "stock" : "quantity";
  const available = toNumber(item[stockField]);
  if (available < quantity) {
    const error = new Error(`Insufficient stock. Available ${available}.`);
    error.status = 409;
    throw error;
  }

  item[stockField] = Number((available - quantity).toFixed(4));
  if (type === "raw") {
    item.currentStock = item.quantity;
    item.lowStockAlert = isBelowMinStock({
      quantity: item.quantity,
      unit: item.unit,
      minStock: item.minStock,
      minStockUnit: item.minStockUnit
    });
  }

  await item.save();
  if (type === "raw") {
    await syncMenuAvailability(getTenantRestaurantId(req));
  }
};

const serializeWastage = (entry = {}) => {
  const plain = entry && typeof entry.toObject === "function" ? entry.toObject() : { ...(entry || {}) };
  return {
    ...plain,
    itemId: plain.itemId || plain.ingredientId,
    itemName: plain.ingredientName,
    value: toNumber(plain.value ?? plain.estimatedCost),
    estimatedCost: toNumber(plain.estimatedCost ?? plain.value)
  };
};

const getWastageEntries = async (req, res) => {
  try {
    await assertCloud(req);
    const filter = withTenantFilter(req, buildSearchFilter(req.query, ["ingredientName", "reason", "type"]));
    const type = cleanText(req.query.type).toLowerCase();
    if (["raw", "prep", "packaging"].includes(type)) {
      filter.type = type;
    }

    const entries = (await Wastage.find(filter).sort({ createdAt: -1 }).limit(1000)).map(serializeWastage);
    const now = new Date();
    const weekStart = addDays(-7);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const sales = await Order.find(
      withTenantFilter(req, {
        createdAt: { $gte: monthStart, $lte: now },
        status: { $in: ["DELIVERED", "DISPATCHED", "COMPLETED", "DONE"] }
      })
    ).lean();
    const monthlySales = sales.reduce((sum, order) => sum + toNumber(order.totalAmount || order.grandTotal), 0);
    const totalWastage = entries.reduce((sum, entry) => sum + toNumber(entry.value), 0);
    const weeklyWastage = entries
      .filter((entry) => new Date(entry.createdAt) >= weekStart)
      .reduce((sum, entry) => sum + toNumber(entry.value), 0);
    const monthlyWastage = entries
      .filter((entry) => new Date(entry.createdAt) >= monthStart)
      .reduce((sum, entry) => sum + toNumber(entry.value), 0);
    const byReason = {};
    const byType = {};
    const trend = {};
    entries.forEach((entry) => {
      const reason = entry.reason || "Unspecified";
      byReason[reason] = toNumber(byReason[reason]) + toNumber(entry.value);
      byType[entry.type || "raw"] = toNumber(byType[entry.type || "raw"]) + toNumber(entry.value);
      const key = new Date(entry.createdAt).toISOString().slice(0, 10);
      trend[key] = toNumber(trend[key]) + toNumber(entry.value);
    });

    const metrics = {
      totalWastage: Number(totalWastage.toFixed(2)),
      quantityWasted: Number(entries.reduce((sum, entry) => sum + toNumber(entry.quantity), 0).toFixed(2)),
      weeklyWastage: Number(weeklyWastage.toFixed(2)),
      monthlyWastage: Number(monthlyWastage.toFixed(2)),
      percentOfSales: monthlySales ? Number(((monthlyWastage / monthlySales) * 100).toFixed(2)) : 0,
      categoryWise: byType,
      reasonWise: byReason,
      trend
    };

    return res.json({ ...paginateRows(entries, req.query), metrics });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const createWastageEntry = async (req, res) => {
  try {
    const restaurantId = await assertCloud(req);
    const type = ["raw", "prep", "packaging"].includes(cleanText(req.body?.type).toLowerCase())
      ? cleanText(req.body.type).toLowerCase()
      : "raw";
    const itemId = cleanText(req.body?.itemId || req.body?.ingredientId);
    const quantity = Math.max(0, toNumber(req.body?.quantity));
    const reason = cleanText(req.body?.reason);
    if (!itemId) return res.status(400).json({ message: "itemId is required" });
    if (quantity <= 0) return res.status(400).json({ message: "Quantity must be greater than zero" });

    const item = await findWastageItem(req, type, itemId);
    await deductWastageStock({ req, item, type, quantity });

    const unitCost =
      type === "packaging"
        ? toNumber(item.costPerUnit)
        : type === "prep"
          ? toNumber(item.cost) / Math.max(1, toNumber(item.quantity) + quantity)
          : toNumber(item.costPerUnit ?? item.pricePerUnit);
    const value = Number((quantity * unitCost).toFixed(2));
    const created = await Wastage.create({
      restaurantId,
      ingredientId: type === "raw" ? item._id : null,
      itemId: item._id,
      type,
      ingredientName: item.name,
      quantity,
      unit: item.unit || "kg",
      reason,
      estimatedCost: value,
      value,
      createdBy: req.user?.userId || null
    });

    emitInventoryUpdate(req, { scope: "wastage", action: "created", itemId: created._id });
    return res.status(201).json(serializeWastage(created));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const deleteWastageEntry = async (req, res) => {
  try {
    await assertCloud(req);
    const deleted = await Wastage.findOneAndDelete(withTenantDocFilter(req, req.params.id));
    if (!deleted) return res.status(404).json({ message: "Wastage entry not found" });
    emitInventoryUpdate(req, { scope: "wastage", action: "deleted", itemId: req.params.id });
    return res.json({ message: "Wastage entry deleted" });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const normalizeSupplierPayload = (body = {}) => ({
  name: cleanText(body.name),
  contact: cleanText(body.contact || body.phone || body.email),
  contactPerson: cleanText(body.contactPerson),
  phone: cleanText(body.phone || body.contact),
  email: cleanText(body.email).toLowerCase(),
  address: cleanText(body.address),
  notes: cleanText(body.notes),
  rating: Math.min(5, Math.max(0, toNumber(body.rating))),
  onTimeDelivery: Math.min(100, Math.max(0, toNumber(body.onTimeDelivery, 100))),
  category: cleanText(body.category) || "General",
  isActive: body.isActive === undefined ? true : Boolean(body.isActive)
});

const serializeSupplier = (supplier = {}, purchaseHistory = []) => {
  const plain =
    supplier && typeof supplier.toObject === "function" ? supplier.toObject() : { ...(supplier || {}) };
  return {
    ...plain,
    contact: plain.contact || plain.phone || plain.email || "",
    linkedPurchaseHistory: purchaseHistory.filter(
      (order) => String(order.supplierId || "") === String(plain._id || "")
    )
  };
};

const getSuppliers = async (req, res) => {
  try {
    await assertCloud(req);
    const filter = withTenantFilter(req, buildSearchFilter(req.query, ["name", "category", "phone", "email"]));
    const suppliers = await Supplier.find(filter).sort({ isActive: -1, name: 1 });
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const purchaseOrders = await PurchaseOrder.find(
      withTenantFilter(req, {
        createdAt: { $gte: monthStart }
      })
    ).lean();
    const rows = suppliers.map((supplier) => serializeSupplier(supplier, purchaseOrders));
    const monthlyPurchase = purchaseOrders.reduce((sum, po) => sum + toNumber(po.totalAmount), 0);
    const metrics = {
      totalSuppliers: rows.length,
      activeSuppliers: rows.filter((supplier) => supplier.isActive !== false).length,
      monthlyPurchase: Number(monthlyPurchase.toFixed(2)),
      onTimeDelivery: rows.length
        ? Number(
            (
              rows.reduce((sum, supplier) => sum + toNumber(supplier.onTimeDelivery), 0) / rows.length
            ).toFixed(1)
          )
        : 100
    };
    return res.json({ ...paginateRows(rows, req.query), metrics });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const createSupplier = async (req, res) => {
  try {
    const restaurantId = await assertCloud(req);
    const payload = normalizeSupplierPayload(req.body);
    if (!payload.name) return res.status(400).json({ message: "Supplier name is required" });
    const created = await Supplier.create({ restaurantId, ...payload });
    emitInventoryUpdate(req, { scope: "suppliers", action: "created", itemId: created._id });
    return res.status(201).json(serializeSupplier(created));
  } catch (err) {
    if (err?.code === 11000) return res.status(409).json({ message: "Supplier already exists" });
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const updateSupplier = async (req, res) => {
  try {
    await assertCloud(req);
    const payload = normalizeSupplierPayload(req.body);
    if (!payload.name) return res.status(400).json({ message: "Supplier name is required" });
    const updated = await Supplier.findOneAndUpdate(withTenantDocFilter(req, req.params.id), payload, {
      new: true,
      runValidators: true
    });
    if (!updated) return res.status(404).json({ message: "Supplier not found" });
    emitInventoryUpdate(req, { scope: "suppliers", action: "updated", itemId: updated._id });
    return res.json(serializeSupplier(updated));
  } catch (err) {
    if (err?.code === 11000) return res.status(409).json({ message: "Supplier already exists" });
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const deleteSupplier = async (req, res) => {
  try {
    await assertCloud(req);
    const deleted = await Supplier.findOneAndDelete(withTenantDocFilter(req, req.params.id));
    if (!deleted) return res.status(404).json({ message: "Supplier not found" });
    emitInventoryUpdate(req, { scope: "suppliers", action: "deleted", itemId: req.params.id });
    return res.json({ message: "Supplier deleted" });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const normalizePOStatus = (value = "OPEN") => {
  const normalized = cleanText(value).toUpperCase().replace(/[\s-]+/g, "_");
  if (normalized === "DRAFT" || normalized === "ORDERED") return "OPEN";
  if (normalized === "RECEIVED") return "DELIVERED";
  return PO_STATUSES.includes(normalized) ? normalized : "OPEN";
};

const normalizePOLines = (items = []) =>
  (Array.isArray(items) ? items : [])
    .map((line) => {
      const quantity = Math.max(0, toNumber(line.qty ?? line.quantity));
      const unitPrice = Math.max(0, toNumber(line.cost ?? line.unitPrice));
      const type = ["raw", "prep", "packaging"].includes(cleanText(line.type).toLowerCase())
        ? cleanText(line.type).toLowerCase()
        : "raw";
      return {
        itemId: line.itemId || null,
        type,
        ingredientName: cleanText(line.itemName || line.ingredientName),
        quantity,
        qty: quantity,
        unit: normalizeUnit(line.unit || (type === "packaging" ? "pcs" : "kg")) || "kg",
        unitPrice,
        cost: unitPrice,
        lineTotal: Number((quantity * unitPrice).toFixed(2))
      };
    })
    .filter((line) => line.ingredientName && line.quantity > 0);

const buildPONumber = async (restaurantId) => {
  const count = await PurchaseOrder.countDocuments({ restaurantId });
  const date = new Date();
  return `PO-${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(
    date.getDate()
  ).padStart(2, "0")}-${String(count + 1).padStart(5, "0")}`;
};

const serializePurchaseOrder = (po = {}) => {
  const plain = po && typeof po.toObject === "function" ? po.toObject() : { ...(po || {}) };
  return {
    ...plain,
    status: normalizePOStatus(plain.status),
    items: Array.isArray(plain.items) && plain.items.length ? plain.items : plain.lines || [],
    expectedDelivery: plain.expectedDelivery || plain.expectedDate || null
  };
};

const getPurchaseOrders = async (req, res) => {
  try {
    await assertCloud(req);
    const filter = withTenantFilter(req, buildSearchFilter(req.query, ["poNumber", "supplierName", "status"]));
    const status = normalizePOStatus(req.query.status || "");
    if (cleanText(req.query.status) && cleanText(req.query.status).toUpperCase() !== "ALL") {
      filter.status = status;
    }
    const rows = (await PurchaseOrder.find(filter).sort({ createdAt: -1 }).limit(1000)).map(
      serializePurchaseOrder
    );
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const monthlyValue = rows
      .filter((po) => new Date(po.createdAt) >= monthStart)
      .reduce((sum, po) => sum + toNumber(po.totalAmount), 0);
    const metrics = {
      totalPOs: rows.length,
      open: rows.filter((po) => po.status === "OPEN").length,
      inTransit: rows.filter((po) => po.status === "IN_TRANSIT").length,
      received: rows.filter((po) => po.status === "DELIVERED").length,
      monthlyValue: Number(monthlyValue.toFixed(2))
    };
    return res.json({ ...paginateRows(rows, req.query), metrics });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const normalizePOPayload = async (req, body = {}, existing = null) => {
  const restaurantId = getTenantRestaurantId(req);
  const items = normalizePOLines(body.items || body.lines);
  const supplierId = cleanText(body.supplierId);
  const supplier = supplierId ? await Supplier.findOne({ restaurantId, _id: supplierId }).lean() : null;
  const subtotal = items.reduce((sum, item) => sum + toNumber(item.lineTotal), 0);
  const taxAmount = Math.max(0, toNumber(body.taxAmount));
  return {
    poNumber: existing?.poNumber || cleanText(body.poNumber) || (await buildPONumber(restaurantId)),
    supplierId: supplier?._id || null,
    supplierName: supplier?.name || cleanText(body.supplierName),
    items,
    lines: items,
    subtotal,
    taxAmount,
    totalAmount: Number((subtotal + taxAmount).toFixed(2)),
    status: normalizePOStatus(body.status || existing?.status || "OPEN"),
    paymentStatus: cleanText(body.paymentStatus || existing?.paymentStatus || "UNPAID").toUpperCase(),
    expectedDelivery: body.expectedDelivery ? new Date(body.expectedDelivery) : null,
    expectedDate: body.expectedDelivery ? new Date(body.expectedDelivery) : null,
    notes: cleanText(body.notes)
  };
};

const applyPurchaseOrderReceipt = async (req, purchaseOrder) => {
  const restaurantId = getTenantRestaurantId(req);
  const lines = normalizePOLines(purchaseOrder.items || purchaseOrder.lines);

  for (const line of lines) {
    if (line.type === "packaging") {
      await Packaging.findOneAndUpdate(
        line.itemId
          ? { restaurantId, _id: line.itemId }
          : { restaurantId, name: line.ingredientName },
        {
          $setOnInsert: {
            restaurantId,
            name: line.ingredientName,
            minStock: 0
          },
          $set: {
            unit: line.unit,
            costPerUnit: line.unitPrice,
            supplierId: purchaseOrder.supplierId || null,
            supplierName: purchaseOrder.supplierName || ""
          },
          $inc: { stock: line.quantity }
        },
        { upsert: true, new: true }
      );
      continue;
    }

    if (line.type === "prep") {
      await PrepItem.findOneAndUpdate(
        line.itemId
          ? { restaurantId, _id: line.itemId }
          : { restaurantId, name: line.ingredientName, batchNo: `PO-${purchaseOrder.poNumber}` },
        {
          $setOnInsert: {
            restaurantId,
            name: line.ingredientName,
            batchNo: `PO-${purchaseOrder.poNumber}`,
            preparedAt: new Date()
          },
          $set: {
            unit: line.unit,
            cost: line.lineTotal
          },
          $inc: { quantity: line.quantity }
        },
        { upsert: true, new: true }
      );
      continue;
    }

    await RawMaterial.findOneAndUpdate(
      line.itemId
        ? { restaurantId, _id: line.itemId, stockCategory: "RAW_MATERIAL" }
        : { restaurantId, name: line.ingredientName, stockCategory: "RAW_MATERIAL" },
      {
        $setOnInsert: {
          restaurantId,
          name: line.ingredientName,
          minStock: 0,
          stockCategory: "RAW_MATERIAL"
        },
        $set: {
          unit: line.unit,
          minStockUnit: line.unit,
          costPerUnit: line.unitPrice,
          pricePerUnit: line.unitPrice,
          purchasePrice: line.unitPrice,
          supplierId: purchaseOrder.supplierId || null,
          supplier: purchaseOrder.supplierName || "",
          vendorName: purchaseOrder.supplierName || ""
        },
        $inc: {
          quantity: line.quantity,
          currentStock: line.quantity,
          stock: line.quantity
        }
      },
      { upsert: true, new: true }
    );
  }

  await syncMenuAvailability(restaurantId);
};

const createPurchaseOrder = async (req, res) => {
  try {
    const restaurantId = await assertCloud(req);
    const payload = await normalizePOPayload(req, req.body);
    if (!payload.items.length) return res.status(400).json({ message: "Add at least one PO item" });

    const created = await PurchaseOrder.create({
      restaurantId,
      ...payload,
      createdBy: req.user?.userId || null
    });
    if (created.status === "DELIVERED") {
      await applyPurchaseOrderReceipt(req, created);
      created.receivedAt = created.receivedAt || new Date();
      await created.save();
    }
    emitInventoryUpdate(req, { scope: "purchase-orders", action: "created", itemId: created._id });
    return res.status(201).json(serializePurchaseOrder(created));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const updatePurchaseOrder = async (req, res) => {
  try {
    await assertCloud(req);
    const existing = await PurchaseOrder.findOne(withTenantDocFilter(req, req.params.id));
    if (!existing) return res.status(404).json({ message: "Purchase order not found" });
    if (["DELIVERED", "RECEIVED", "CANCELLED"].includes(normalizePOStatus(existing.status))) {
      return res.status(400).json({ message: "Closed purchase orders cannot be edited" });
    }

    const payload = await normalizePOPayload(req, req.body, existing);
    if (!payload.items.length) return res.status(400).json({ message: "Add at least one PO item" });
    Object.assign(existing, payload);
    await existing.save();
    emitInventoryUpdate(req, { scope: "purchase-orders", action: "updated", itemId: existing._id });
    return res.json(serializePurchaseOrder(existing));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const updatePurchaseOrderStatus = async (req, res) => {
  try {
    await assertCloud(req);
    const purchaseOrder = await PurchaseOrder.findOne(withTenantDocFilter(req, req.params.id));
    if (!purchaseOrder) return res.status(404).json({ message: "Purchase order not found" });
    const nextStatus = normalizePOStatus(req.body?.status);
    const currentStatus = normalizePOStatus(purchaseOrder.status);
    if (currentStatus === "DELIVERED" || currentStatus === "CANCELLED") {
      return res.status(400).json({ message: "Purchase order is closed" });
    }

    purchaseOrder.status = nextStatus;
    if (nextStatus === "DELIVERED") {
      await applyPurchaseOrderReceipt(req, purchaseOrder);
      purchaseOrder.receivedAt = new Date();
    }
    await purchaseOrder.save();
    emitInventoryUpdate(req, {
      scope: "purchase-orders",
      action: nextStatus === "DELIVERED" ? "received" : "status-updated",
      itemId: purchaseOrder._id
    });
    return res.json(serializePurchaseOrder(purchaseOrder));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

const deletePurchaseOrder = async (req, res) => {
  try {
    await assertCloud(req);
    const deleted = await PurchaseOrder.findOneAndDelete(withTenantDocFilter(req, req.params.id));
    if (!deleted) return res.status(404).json({ message: "Purchase order not found" });
    emitInventoryUpdate(req, { scope: "purchase-orders", action: "deleted", itemId: req.params.id });
    return res.json({ message: "Purchase order deleted" });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.serverError(err);
  }
};

module.exports = {
  getRawMaterials,
  createRawMaterial,
  updateRawMaterial,
  deleteRawMaterial,
  getPrepItems,
  createPrepItem,
  updatePrepItem,
  deletePrepItem,
  getPackagingItems,
  createPackagingItem,
  updatePackagingItem,
  deletePackagingItem,
  getWastageEntries,
  createWastageEntry,
  deleteWastageEntry,
  getSuppliers,
  createSupplier,
  updateSupplier,
  deleteSupplier,
  getPurchaseOrders,
  createPurchaseOrder,
  updatePurchaseOrder,
  updatePurchaseOrderStatus,
  deletePurchaseOrder
};
