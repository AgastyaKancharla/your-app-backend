const express = require("express");
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const path = require("path");

const Ingredient = require("../models/Ingredient");
const Recipe = require("../models/Recipe");
const Order = require("../models/Order");
const cloudInventoryController = require("../controllers/cloudInventoryController");
const hybridInventoryController = require("../controllers/hybridInventoryController");
const requirePermission = require("../middleware/requirePermission");
const { requirePlanFeature } = require("../middleware/planLimitMiddleware");
const {
  deductInventoryForItems,
  syncMenuAvailability
} = require("../services/cloudKitchenOperationsService");
const {
  createInventoryMovement,
  runInInventoryTransaction
} = require("../services/inventoryMovementService");
const { getQuantityPerPack } = require("../utils/recipeQuantities");
const {
  getTenantRestaurantId,
  withTenantFilter,
  withTenantDocFilter
} = require("../utils/tenantScope");
const { ensureStorageDir } = require("../utils/storagePaths");
const { isBelowMinStock, normalizeUnit } = require("../utils/unitConversion");
const {
  assertCloudKitchenWorkspace,
  getCloudKitchenWorkspaceIfAvailable
} = require("../utils/cloudKitchenWorkspace");

const router = express.Router();

router.use(
  requirePlanFeature("inventoryManagement", {
    requiredPlan: "GROWTH",
    message: "Inventory is available on GROWTH and above plans."
  })
);

const uploadDir = ensureStorageDir("imports");
const MAX_IMPORT_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_ROWS = 5000;
const ALLOWED_IMPORT_MIME_TYPES = new Set([
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel",
  "text/plain",
  "application/octet-stream"
]);

const upload = multer({
  dest: uploadDir,
  limits: {
    fileSize: MAX_IMPORT_FILE_SIZE_BYTES
  },
  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file?.originalname || "").toLowerCase();
    const mimeType = String(file?.mimetype || "").toLowerCase();

    if (extension !== ".csv" || (mimeType && !ALLOWED_IMPORT_MIME_TYPES.has(mimeType))) {
      const error = new Error("Only CSV files are supported currently. Save Excel as CSV and retry.");
      error.status = 400;
      return cb(error);
    }

    return cb(null, true);
  }
});

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const escapeRegex = (value = "") => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeIngredientPayload = (body = {}) => ({
  name: String(body.name || body.itemName || "").trim(),
  itemName: String(body.itemName || body.name || "").trim(),
  quantity: Math.max(0, toNumber(body.quantity ?? body.stock)),
  unit: normalizeUnit(body.unit || "kg") || "kg",
  minStock: Math.max(0, toNumber(body.minStock ?? body.threshold)),
  minStockUnit: normalizeUnit(body.minStockUnit || body.unit || "kg") || "kg",
  pricePerUnit: Math.max(0, toNumber(body.pricePerUnit)),
  supplier: String(body.supplier || body.vendorName || "").trim(),
  stockCategory:
    String(body.stockCategory || "").trim().toUpperCase() === "PACKAGING"
      ? "PACKAGING"
      : "RAW_MATERIAL",
  purchasePrice: Math.max(0, toNumber(body.purchasePrice ?? body.pricePerUnit)),
  purchaseDate: body.purchaseDate || null,
  expiryDate: body.expiryDate || null,
  vendorName: String(body.vendorName || "").trim(),
  vendorPhone: String(body.vendorPhone || "").trim()
});

const applyStockAliases = (item) => {
  if (!item) {
    return item;
  }

  item.itemName = item.name;
  item.stock = Number(item.quantity || 0);
  item.threshold = Number(item.minStock || 0);
  item.currentStock = Number(item.quantity || 0);
  item.minStockAlert = Number(item.minStock || 0);
  item.minStockUnit = normalizeUnit(item.minStockUnit || item.unit || "kg") || "kg";
  item.lowStockAlert = isBelowMinStock({
    quantity: item.currentStock,
    unit: item.unit,
    minStock: item.minStockAlert,
    minStockUnit: item.minStockUnit
  });
  item.stockCategory =
    String(item.stockCategory || "").trim().toUpperCase() === "PACKAGING"
      ? "PACKAGING"
      : "RAW_MATERIAL";
  item.purchasePrice = Number(item.pricePerUnit || item.purchasePrice || 0);
  item.supplier = item.supplier || item.vendorName || "";
  return item;
};

const normalizeName = (value = "") => String(value || "").trim().toLowerCase();

const maybeSyncCloudKitchenAvailability = async (req) => {
  const workspace = await getCloudKitchenWorkspaceIfAvailable(req);
  if (!workspace?._id) {
    return [];
  }

  return syncMenuAvailability(workspace._id);
};

const runBulkIngredientImport = async ({ rows, req, restaurantId }) => {
  if (!Array.isArray(rows) || !rows.length) {
    const error = new Error("No valid ingredient rows found to import");
    error.status = 400;
    throw error;
  }

  if (rows.length > MAX_IMPORT_ROWS) {
    const error = new Error(`Bulk import is limited to ${MAX_IMPORT_ROWS} rows per upload`);
    error.status = 400;
    throw error;
  }

  await runInInventoryTransaction(async (session) => {
    for (const row of rows) {
      let ingredient = await Ingredient.findOne({ restaurantId, name: row.name }).session(session);
      if (!ingredient) {
        const created = await Ingredient.create(
          [
            {
              restaurantId,
              ...row,
              quantity: 0,
              currentStock: 0,
              stock: 0,
              minStockAlert: row.minStock,
              purchasePrice: row.purchasePrice,
              lowStockAlert: isBelowMinStock({
                quantity: 0,
                unit: row.unit,
                minStock: row.minStock,
                minStockUnit: row.minStockUnit
              })
            }
          ],
          { session }
        );
        ingredient = created[0];
      } else {
        ingredient.unit = row.unit;
        ingredient.minStock = row.minStock;
        ingredient.minStockUnit = row.minStockUnit || row.unit;
        ingredient.pricePerUnit = row.pricePerUnit;
        ingredient.costPerUnit = row.pricePerUnit;
        ingredient.stockCategory = row.stockCategory;
        ingredient.minStockAlert = row.minStock;
        ingredient.purchasePrice = row.purchasePrice;
        ingredient.supplier = row.supplier || row.vendorName;
        ingredient.purchaseDate = row.purchaseDate;
        ingredient.expiryDate = row.expiryDate;
        ingredient.vendorName = row.vendorName;
        ingredient.vendorPhone = row.vendorPhone;
        await ingredient.save({ session });
      }

      if (row.quantity > 0) {
        await createInventoryMovement({
          restaurantId,
          itemId: ingredient._id,
          itemType: "raw_material",
          movementType: "purchase",
          quantity: row.quantity,
          unit: row.unit,
          costPerUnit: row.pricePerUnit,
          referenceType: "adjustment",
          createdBy: req.user?.userId || null,
          notes: "Bulk inventory import",
          session
        });
      }
    }
  });
  await syncLowStockAlerts(withTenantFilter(req));
  await maybeSyncCloudKitchenAvailability(req);

  return {
    count: rows.length
  };
};

const syncLowStockAlerts = async (filter) => {
  const ingredients = await Ingredient.find(filter);
  if (!ingredients.length) {
    return;
  }

  const operations = ingredients.map((ingredient) => ({
    updateOne: {
      filter: { _id: ingredient._id },
      update: {
        $set: {
          lowStockAlert: isBelowMinStock({
            quantity: ingredient.quantity,
            unit: ingredient.unit,
            minStock: ingredient.minStock,
            minStockUnit: ingredient.minStockUnit
          })
        }
      }
    }
  }));

  await Ingredient.bulkWrite(operations, { ordered: false });
};

router
  .route("/raw")
  .get(requirePermission("inventory.view"), cloudInventoryController.getRawMaterials)
  .post(requirePermission("inventory.create"), cloudInventoryController.createRawMaterial);

router
  .route("/raw/:id")
  .put(requirePermission("inventory.update"), cloudInventoryController.updateRawMaterial)
  .delete(requirePermission("inventory.delete"), cloudInventoryController.deleteRawMaterial);

router
  .route("/prep")
  .get(requirePermission("inventory.view"), cloudInventoryController.getPrepItems)
  .post(requirePermission("inventory.create"), cloudInventoryController.createPrepItem);

router
  .route("/prep/:id")
  .put(requirePermission("inventory.update"), cloudInventoryController.updatePrepItem)
  .delete(requirePermission("inventory.delete"), cloudInventoryController.deletePrepItem);

router
  .route("/packaging")
  .get(requirePermission("inventory.view"), cloudInventoryController.getPackagingItems)
  .post(requirePermission("inventory.create"), cloudInventoryController.createPackagingItem);

router
  .route("/packaging/:id")
  .put(requirePermission("inventory.update"), cloudInventoryController.updatePackagingItem)
  .delete(requirePermission("inventory.delete"), cloudInventoryController.deletePackagingItem);

router
  .route("/wastage")
  .get(requirePermission("inventory.view"), cloudInventoryController.getWastageEntries)
  .post(requirePermission("inventory.create"), cloudInventoryController.createWastageEntry);

router
  .route("/wastage/:id")
  .delete(requirePermission("inventory.delete"), cloudInventoryController.deleteWastageEntry);

router
  .route("/suppliers")
  .get(requirePermission("inventory.view"), cloudInventoryController.getSuppliers)
  .post(requirePermission("inventory.create"), cloudInventoryController.createSupplier);

router
  .route("/suppliers/:id")
  .put(requirePermission("inventory.update"), cloudInventoryController.updateSupplier)
  .delete(requirePermission("inventory.delete"), cloudInventoryController.deleteSupplier);

router
  .route("/purchase-orders")
  .get(requirePermission("inventory.view"), cloudInventoryController.getPurchaseOrders)
  .post(requirePermission("inventory.create"), cloudInventoryController.createPurchaseOrder);

router
  .route("/purchase-orders/:id")
  .put(requirePermission("inventory.update"), cloudInventoryController.updatePurchaseOrder)
  .delete(requirePermission("inventory.delete"), cloudInventoryController.deletePurchaseOrder);

router.patch(
  "/purchase-orders/:id/status",
  requirePermission("inventory.update"),
  cloudInventoryController.updatePurchaseOrderStatus
);

router.post(
  "/purchase-orders/:id/receive",
  requirePermission("inventory.update"),
  hybridInventoryController.receivePO
);

router.get(
  "/movements/summary",
  requirePermission("inventory.view"),
  hybridInventoryController.getMovementSummary
);

router.get(
  "/movements",
  requirePermission("inventory.view"),
  hybridInventoryController.getMovements
);

router.post(
  "/adjustments",
  requirePermission("inventory.update"),
  hybridInventoryController.createAdjustment
);

router.post(
  "/prep/produce",
  requirePermission("inventory.create"),
  hybridInventoryController.createPrepProduction
);

router
  .route("/reconciliations")
  .get(requirePermission("inventory.view"), hybridInventoryController.listReconciliations)
  .post(requirePermission("inventory.create"), hybridInventoryController.createReconciliation);

router.patch(
  "/reconciliations/:id/approve",
  requirePermission("inventory.update"),
  hybridInventoryController.approveReconciliationRequest
);

router.patch(
  "/reconciliations/:id/reject",
  requirePermission("inventory.update"),
  hybridInventoryController.rejectReconciliation
);

router.get(
  "/analytics/stock",
  requirePermission("inventory.view"),
  hybridInventoryController.stockAnalytics
);

router.patch(
  "/settings",
  requirePermission("inventory.update"),
  hybridInventoryController.updateInventorySettings
);

router.get(
  "/purchase-suggestions",
  requirePermission("inventory.view"),
  hybridInventoryController.purchaseSuggestions
);

router.get(
  "/supplier-price-history",
  requirePermission("inventory.view"),
  hybridInventoryController.priceHistory
);

// =============================
// ADD Ingredient
// =============================
router.post("/", requirePermission("inventory.create"), async (req, res) => {
  try {
    const restaurantId = getTenantRestaurantId(req);
    const payload = normalizeIngredientPayload(req.body);

    if (!payload.name) {
      return res.status(400).json({ message: "Ingredient name is required" });
    }

    if (payload.quantity <= 0) {
      return res.status(400).json({ message: "Quantity must be greater than zero" });
    }

    let result;
    await runInInventoryTransaction(async (session) => {
      let ingredient = await Ingredient.findOne(
        withTenantFilter(req, {
          name: {
            $regex: new RegExp(`^${escapeRegex(payload.name)}$`, "i")
          }
        })
      ).session(session);

      if (!ingredient) {
        const created = await Ingredient.create(
          [
            {
              restaurantId,
              ...payload,
              quantity: 0,
              currentStock: 0,
              stock: 0,
              minStockAlert: payload.minStock,
              purchasePrice: payload.purchasePrice,
              lowStockAlert: isBelowMinStock({
                quantity: 0,
                unit: payload.unit,
                minStock: payload.minStock,
                minStockUnit: payload.minStockUnit
              })
            }
          ],
          { session }
        );
        ingredient = created[0];
      } else {
        ingredient.unit = payload.unit;
        ingredient.minStock = payload.minStock;
        ingredient.minStockUnit = payload.minStockUnit || payload.unit;
        ingredient.pricePerUnit = payload.pricePerUnit;
        ingredient.costPerUnit = payload.pricePerUnit;
        ingredient.stockCategory = payload.stockCategory;
        ingredient.minStockAlert = payload.minStock;
        ingredient.purchasePrice = payload.purchasePrice;
        ingredient.supplier = payload.supplier;
        ingredient.purchaseDate = payload.purchaseDate;
        ingredient.expiryDate = payload.expiryDate;
        ingredient.vendorName = payload.vendorName;
        ingredient.vendorPhone = payload.vendorPhone;
        await ingredient.save({ session });
      }

      const movementResult = await createInventoryMovement({
        restaurantId,
        itemId: ingredient._id,
        itemType: "raw_material",
        movementType: "purchase",
        quantity: payload.quantity,
        unit: payload.unit,
        costPerUnit: payload.pricePerUnit,
        referenceType: "adjustment",
        createdBy: req.user?.userId || null,
        notes: "Inventory stock-in",
        session
      });
      result = movementResult.item;
    });

    await maybeSyncCloudKitchenAvailability(req);
    res.status(201).json(result);
  } catch (err) {
    return res.serverError(err);
  }
});

// =============================
// GET All Ingredients
// =============================
router.get("/", requirePermission("inventory.view"), async (req, res) => {
  try {
    const filter = withTenantFilter(req);
    const stockCategory = String(req.query?.stockCategory || "").trim().toUpperCase();
    if (stockCategory === "PACKAGING" || stockCategory === "RAW_MATERIAL") {
      filter.stockCategory = stockCategory;
    }

    const ingredients = await Ingredient.find(filter).sort({ name: 1 });
    ingredients.forEach(applyStockAliases);
    res.json(ingredients);
  } catch (err) {
    return res.serverError(err);
  }
});

router.post(
  "/deduct",
  requirePermission("inventory.update"),
  async (req, res) => {
    try {
      await assertCloudKitchenWorkspace(req);

      const restaurantId = getTenantRestaurantId(req);
      let orderItems = Array.isArray(req.body?.items) ? req.body.items : [];

      if (!orderItems.length && req.body?.orderId) {
        const order = await Order.findOne(withTenantDocFilter(req, req.body.orderId));
        if (!order) {
          return res.status(404).json({ message: "Order not found" });
        }

        orderItems = order.items || [];
      }

      if (!orderItems.length) {
        return res.status(400).json({ message: "items or orderId is required" });
      }

      const result = await deductInventoryForItems({
        restaurantId,
        orderItems
      });

      return res.json({
        message: "Inventory deducted successfully",
        ...result
      });
    } catch (err) {
      if (err.status) {
        return res.status(err.status).json({ message: err.message });
      }
      return res.serverError(err);
    }
  }
);

// =============================
// GET Low Stock Ingredients
// =============================
router.get(
  "/low-stock",
  requirePermission("inventory.view"),
  async (req, res) => {
  try {
    const lowStockItems = await Ingredient.find(
      withTenantFilter(req, {
        $expr: { $lte: ["$quantity", "$minStock"] }
      })
    ).sort({ quantity: 1 });

    lowStockItems.forEach(applyStockAliases);

    res.json(lowStockItems);
  } catch (err) {
    return res.serverError(err);
  }
});

// =============================
// GET Inventory Overview (recipe-wise + usage)
// =============================
router.get(
  "/overview",
  requirePermission("inventory.view"),
  async (req, res) => {
    try {
      const [ingredients, recipes, orders] = await Promise.all([
        Ingredient.find(withTenantFilter(req)).sort({ name: 1 }),
        Recipe.find(withTenantFilter(req)).sort({ menuItem: 1 }),
        Order.find(withTenantFilter(req)).sort({ createdAt: -1 }).limit(1500)
      ]);

      ingredients.forEach(applyStockAliases);

      const recipeByDish = recipes.reduce((acc, recipe) => {
        acc[normalizeName(recipe.menuItem)] = recipe;
        return acc;
      }, {});

      const usageByIngredient = {};
      const daysWindow = 30;
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - daysWindow);

      orders.forEach((order) => {
        if (normalizeName(order.status) !== "completed") {
          return;
        }
        if (!order.createdAt || new Date(order.createdAt) < startDate) {
          return;
        }

        (order.items || []).forEach((orderedItem) => {
          const normalizedDisplayName = normalizeName(
            String(orderedItem.displayName || "").replace(/\s*\(.*\)\s*$/, "")
          );
          const recipe =
            recipeByDish[normalizeName(orderedItem.name)] ||
            recipeByDish[normalizeName(orderedItem.displayName)] ||
            recipeByDish[normalizedDisplayName];
          if (!recipe) {
            return;
          }

          (recipe.ingredients || []).forEach((line) => {
            const ingredientKey = normalizeName(line.ingredientName);
            if (!ingredientKey) {
              return;
            }

            usageByIngredient[ingredientKey] =
              Number(usageByIngredient[ingredientKey] || 0) +
              getQuantityPerPack(line) * Number(orderedItem.quantity || 0);
          });
        });
      });

      Object.keys(usageByIngredient).forEach((key) => {
        usageByIngredient[key] = Number(usageByIngredient[key] || 0) / daysWindow;
      });

      const recipeMappings = recipes.flatMap((recipe) =>
        (recipe.ingredients || []).map((line) => ({
          recipeId: recipe._id,
          menuItem: recipe.menuItem,
          packName: recipe.packName || "Pack",
          ingredientName: line.ingredientName,
          quantityPerPack: getQuantityPerPack(line),
          unit: line.unit || "kg"
        }))
      );

      const detailedIngredients = ingredients.map((ingredient) => {
        const key = normalizeName(ingredient.name);
        const usedPerDay = Number(usageByIngredient[key] || 0);
        const quantity = Number(ingredient.quantity || 0);
        const minStock = Number(ingredient.minStock || 0);
        const minStockUnit = normalizeUnit(ingredient.minStockUnit || ingredient.unit || "kg");
        const daysToEmpty = usedPerDay > 0 ? quantity / usedPerDay : null;
        const stockValue = quantity * Number(ingredient.pricePerUnit || 0);
        const ingredientMappings = recipeMappings.filter(
          (mapping) => normalizeName(mapping.ingredientName) === key
        );

        return {
          ...ingredient.toObject(),
          usedPerDay,
          daysToEmpty,
          stockValue,
          lowStockAlert: isBelowMinStock({
            quantity,
            unit: ingredient.unit,
            minStock,
            minStockUnit
          }),
          recipeMappings: ingredientMappings
        };
      });

      const lowStock = detailedIngredients.filter((item) => item.lowStockAlert);
      const totalStockValue = detailedIngredients.reduce(
        (sum, item) => sum + Number(item.stockValue || 0),
        0
      );

      return res.json({
        summary: {
          totalIngredients: detailedIngredients.length,
          lowStockCount: lowStock.length,
          mappedIngredientsCount: new Set(
            recipeMappings.map((mapping) => normalizeName(mapping.ingredientName))
          ).size,
          totalStockValue: Number(totalStockValue.toFixed(2))
        },
        ingredients: detailedIngredients,
        lowStock,
        recipeMappings
      });
    } catch (err) {
      return res.serverError(err);
    }
  }
);

// Repurchase / Update Stock
router.put("/:id", requirePermission("inventory.update"), async (req, res) => {
  try {
    const payload = normalizeIngredientPayload(req.body);

    if (!payload.name) {
      return res.status(400).json({ message: "Ingredient name is required" });
    }

    const restaurantId = getTenantRestaurantId(req);
    let updatedIngredient;
    await runInInventoryTransaction(async (session) => {
      const existing = await Ingredient.findOne(withTenantDocFilter(req, req.params.id)).session(session);

      if (!existing) {
        return;
      }

      const stockDelta = Number((payload.quantity - toNumber(existing.quantity)).toFixed(4));
      existing.name = payload.name;
      existing.itemName = payload.itemName || payload.name;
      existing.unit = payload.unit;
      existing.minStock = payload.minStock;
      existing.minStockUnit = payload.minStockUnit;
      existing.pricePerUnit = payload.pricePerUnit;
      existing.costPerUnit = payload.pricePerUnit;
      existing.minStockAlert = payload.minStock;
      existing.purchasePrice = payload.purchasePrice;
      existing.supplier = payload.supplier;
      existing.stockCategory = payload.stockCategory;
      existing.purchaseDate = payload.purchaseDate;
      existing.expiryDate = payload.expiryDate;
      existing.vendorName = payload.vendorName;
      existing.vendorPhone = payload.vendorPhone;
      await existing.save({ session });

      if (stockDelta) {
        const movementResult = await createInventoryMovement({
          restaurantId,
          itemId: existing._id,
          itemType: "raw_material",
          movementType: "adjustment",
          quantity: stockDelta,
          unit: payload.unit,
          costPerUnit: payload.pricePerUnit,
          referenceType: "adjustment",
          createdBy: req.user?.userId || null,
          notes: "Inventory stock edit",
          allowNegativeStock: true,
          session
        });
        updatedIngredient = movementResult.item;
      } else {
        updatedIngredient = existing;
      }
    });

    if (!updatedIngredient) {
      return res.status(404).json({ message: "Ingredient not found" });
    }

    await maybeSyncCloudKitchenAvailability(req);
    res.json(updatedIngredient);
  } catch (err) {
    return res.serverError(err);
  }
});

router.delete("/:id", requirePermission("inventory.delete"), async (req, res) => {
  try {
    const deleted = await Ingredient.findOneAndDelete(withTenantDocFilter(req, req.params.id));

    if (!deleted) {
      return res.status(404).json({ message: "Ingredient not found" });
    }

    await maybeSyncCloudKitchenAvailability(req);
    res.json({ message: "Ingredient deleted" });
  } catch (err) {
    return res.serverError(err);
  }
});

// =============================
// BULK CSV Upload
// =============================
router.post(
  "/bulk-import-json",
  requirePermission("inventory.create"),
  async (req, res) => {
    try {
      const restaurantId = getTenantRestaurantId(req);
      const rows = Array.isArray(req.body?.rows)
        ? req.body.rows.map(normalizeIngredientPayload).filter((row) => row.name)
        : [];

      const result = await runBulkIngredientImport({
        rows,
        req,
        restaurantId
      });

      return res.json({
        message: "Bulk upload successful",
        count: result.count
      });
    } catch (err) {
      if (err.status) {
        return res.status(err.status).json({ message: err.message });
      }
      return res.serverError(err);
    }
  }
);

router.post(
  "/bulk-upload",
  requirePermission("inventory.create"),
  async (req, res) => {
    upload.single("file")(req, res, async (err) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({
            message: `Import file cannot exceed ${Math.floor(MAX_IMPORT_FILE_SIZE_BYTES / (1024 * 1024))}MB`
          });
        }

        return res.status(err.status || 400).json({
          message: err.message || "Unable to upload import file"
        });
      }

      if (!req.file) {
        return res.status(400).json({ message: "CSV file is required" });
      }

      const restaurantId = getTenantRestaurantId(req);

      try {
        const rows = [];

        await new Promise((resolve, reject) => {
          const readStream = fs.createReadStream(req.file.path);
          const parser = csv();

          readStream
            .pipe(parser)
            .on("data", (data) => {
              if (rows.length >= MAX_IMPORT_ROWS) {
                parser.destroy(
                  new Error(`CSV import is limited to ${MAX_IMPORT_ROWS} rows per upload`)
                );
                return;
              }

              const row = normalizeIngredientPayload(data);

              if (row.name) {
                rows.push(row);
              }
            })
            .on("end", resolve)
            .on("error", reject);
        });

        if (!rows.length) {
          return res.status(400).json({ message: "No valid ingredient rows found in CSV" });
        }

        const result = await runBulkIngredientImport({
          rows,
          req,
          restaurantId
        });

        return res.json({ message: "Bulk upload successful", count: result.count });
      } catch (uploadError) {
        if (uploadError.status) {
          return res.status(uploadError.status).json({ message: uploadError.message });
        }
        return res.serverError(uploadError);
      } finally {
        if (req.file?.path && fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
      }
    });
  }
);

module.exports = router;
