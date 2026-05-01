const express = require("express");
const path = require("path");
const multer = require("multer");

const MenuItem = require("../models/MenuItem");
const requirePermission = require("../middleware/requirePermission");
const { syncMenuAvailability } = require("../services/cloudKitchenOperationsService");
const { getCloudKitchenWorkspaceIfAvailable } = require("../utils/cloudKitchenWorkspace");
const { ensureStorageDir } = require("../utils/storagePaths");
const {
  getTenantRestaurantId,
  withTenantFilter,
  withTenantDocFilter
} = require("../utils/tenantScope");

const router = express.Router();
const menuImagesDir = ensureStorageDir("menu-images");

const allowedImageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const allowedImageMimeTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, menuImagesDir);
  },
  filename: (_req, file, cb) => {
    const extension = path.extname(file?.originalname || "").toLowerCase();
    cb(null, `menu-${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`);
  }
});

const upload = multer({
  storage: uploadStorage,
  limits: {
    fileSize: 5 * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file?.originalname || "").toLowerCase();
    const mimeType = String(file?.mimetype || "").toLowerCase();

    if (!allowedImageExtensions.has(extension) || !allowedImageMimeTypes.has(mimeType)) {
      const error = new Error("Upload a PNG, JPG, JPEG, or WEBP image.");
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

const normalizeTags = (value = []) => {
  const source = Array.isArray(value)
    ? value
    : String(value || "")
        .split(",")
        .map((tag) => tag.trim());

  return Array.from(
    new Set(
      source
        .map((tag) => String(tag || "").trim().toLowerCase())
        .filter(Boolean)
    )
  );
};

const normalizeAvailability = (value = "") => {
  const normalized = String(value || "").trim().toUpperCase();
  return ["IN_STOCK", "LOW_STOCK", "OUT_OF_STOCK"].includes(normalized) ? normalized : "";
};

const normalizeVariants = (variants = []) => {
  if (!Array.isArray(variants)) {
    return [];
  }

  const cleanVariants = variants
    .map((variant) => ({
      name: String(variant?.name || "").trim(),
      price: Math.max(0, toNumber(variant?.price)),
      isDefault: Boolean(variant?.isDefault)
    }))
    .filter((variant) => variant.name && Number.isFinite(variant.price));

  let defaultAssigned = false;
  return cleanVariants.map((variant, index) => {
    const shouldBeDefault = !defaultAssigned && (variant.isDefault || index === 0);
    if (shouldBeDefault) {
      defaultAssigned = true;
    }

    return {
      ...variant,
      isDefault: shouldBeDefault
    };
  });
};

const normalizeAddOns = (addOns = []) => {
  if (!Array.isArray(addOns)) {
    return [];
  }

  return addOns
    .map((addOn) => ({
      name: String(addOn?.name || "").trim(),
      price: Math.max(0, toNumber(addOn?.price)),
      isAvailable: addOn?.isAvailable === undefined ? true : Boolean(addOn.isAvailable)
    }))
    .filter((addOn) => addOn.name && Number.isFinite(addOn.price));
};

const normalizeMenuPayload = (body = {}) => ({
  name: String(body.name || "").trim(),
  category: String(body.category || "General").trim() || "General",
  type: String(body.type || "VEG").trim().toUpperCase() === "NON_VEG" ? "NON_VEG" : "VEG",
  cost: Math.max(0, toNumber(body.cost ?? body.costPrice)),
  costPrice: Math.max(0, toNumber(body.cost ?? body.costPrice)),
  sellingPrice: Math.max(0, toNumber(body.sellingPrice ?? body.price)),
  gstPercentage: Math.max(0, toNumber(body.gstPercentage, 5)),
  availability:
    normalizeAvailability(body.availability) ||
    (body.isAvailable === false || body.isActive === false ? "OUT_OF_STOCK" : "IN_STOCK"),
  isActive: body.isActive === undefined ? true : Boolean(body.isActive),
  isAvailable:
    body.isAvailable === undefined
      ? body.isActive === false
        ? false
        : normalizeAvailability(body.availability) !== "OUT_OF_STOCK"
      : Boolean(body.isAvailable),
  tags: normalizeTags(body.tags),
  // Backward compatibility fields
  price: Math.max(0, toNumber(body.price ?? body.sellingPrice)),
  image: String(body.image || "").trim(),
  expectedPrepTimeMinutes: Math.max(1, toNumber(body.expectedPrepTimeMinutes, 15)),
  recipeId: body.recipeId || null,
  recipeLink: String(body.recipeLink || "").trim(),
  variants: normalizeVariants(body.variants),
  addOns: normalizeAddOns(body.addOns)
});

const serializeMenuItem = (item) => {
  const plainItem = item && typeof item.toObject === "function" ? item.toObject() : { ...(item || {}) };
  const availability =
    normalizeAvailability(plainItem.availability) ||
    (plainItem.isAvailable === false ? "OUT_OF_STOCK" : "IN_STOCK");

  return {
    ...plainItem,
    price: Math.max(0, toNumber(plainItem.price ?? plainItem.sellingPrice)),
    sellingPrice: Math.max(0, toNumber(plainItem.sellingPrice ?? plainItem.price)),
    cost: Math.max(0, toNumber(plainItem.cost ?? plainItem.costPrice)),
    costPrice: Math.max(0, toNumber(plainItem.costPrice ?? plainItem.cost)),
    tags: normalizeTags(plainItem.tags),
    availability,
    isActive: plainItem.isActive !== false,
    isAvailable: plainItem.isActive !== false && availability !== "OUT_OF_STOCK"
  };
};

const maybeSyncCloudKitchenAvailability = async (req, options = {}) => {
  const workspace = await getCloudKitchenWorkspaceIfAvailable(req);
  if (!workspace?._id) {
    return [];
  }

  return syncMenuAvailability(workspace._id, options);
};

const toPublicAssetUrl = (req, fileName) => {
  const origin = `${req.protocol}://${req.get("host")}`;
  return `${origin}/storage/menu-images/${fileName}`;
};

router.post(
  "/upload-image",
  requirePermission("menu.manage"),
  async (req, res) => {
    upload.single("image")(req, res, async (err) => {
      try {
        if (err) {
          if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
            return res.status(400).json({ message: "Menu image cannot exceed 5MB" });
          }

          return res.status(400).json({
            message: err.message || "Unable to upload menu image"
          });
        }

        if (!req.file) {
          return res.status(400).json({ message: "Menu image file is required" });
        }

        return res.status(201).json({
          imageUrl: toPublicAssetUrl(req, req.file.filename)
        });
      } catch (uploadError) {
        return res.serverError(uploadError);
      }
    });
  }
);

router.get("/", requirePermission("pos.view"), async (req, res) => {
  try {
    await maybeSyncCloudKitchenAvailability(req);

    const filter = withTenantFilter(req);
    const search = String(req.query?.search || "").trim();
    const category = String(req.query?.category || "").trim();
    const availability = normalizeAvailability(req.query?.availability || req.query?.status);
    const tags = normalizeTags(req.query?.tags || []);
    const isActiveFilter = String(req.query?.isActive || "").trim().toLowerCase();

    if (category && category.toUpperCase() !== "ALL") {
      filter.category = { $regex: new RegExp(`^${escapeRegex(category)}$`, "i") };
    }

    if (availability) {
      filter.availability = availability;
    }

    if (tags.length) {
      filter.tags = { $in: tags };
    }

    if (isActiveFilter === "true" || isActiveFilter === "false") {
      filter.isActive = isActiveFilter === "true";
    }

    if (search) {
      filter.$or = [
        { name: { $regex: new RegExp(escapeRegex(search), "i") } },
        { category: { $regex: new RegExp(escapeRegex(search), "i") } }
      ];
    }

    const items = await MenuItem.find(filter).sort({ category: 1, name: 1 });
    res.json(items.map(serializeMenuItem));
  } catch (err) {
    return res.serverError(err);
  }
});

router.post("/", requirePermission("menu.manage"), async (req, res) => {
  try {
    const restaurantId = getTenantRestaurantId(req);
    const payload = normalizeMenuPayload(req.body);

    if (!payload.name) {
      return res.status(400).json({ message: "Menu item name is required" });
    }

    if (payload.sellingPrice <= 0) {
      return res.status(400).json({ message: "Selling price must be greater than zero" });
    }

    payload.price = payload.sellingPrice;

    const existing = await MenuItem.findOne(
      withTenantFilter(req, {
        name: {
          $regex: new RegExp(`^${escapeRegex(payload.name)}$`, "i")
        }
      })
    );

    if (existing) {
      return res.status(409).json({
        message: "Menu item already exists. Edit the existing item instead."
      });
    }

    const created = await MenuItem.create({
      restaurantId,
      ...payload
    });

    await maybeSyncCloudKitchenAvailability(req, {
      menuItemIds: [created._id]
    });

    const refreshed = await MenuItem.findById(created._id);
    res.status(201).json(serializeMenuItem(refreshed || created));
  } catch (err) {
    return res.serverError(err);
  }
});

router.put("/:id", requirePermission("menu.manage"), async (req, res) => {
  try {
    const payload = normalizeMenuPayload(req.body);

    if (!payload.name) {
      return res.status(400).json({ message: "Menu item name is required" });
    }

    if (payload.sellingPrice <= 0) {
      return res.status(400).json({ message: "Selling price must be greater than zero" });
    }

    payload.price = payload.sellingPrice;

    const duplicate = await MenuItem.findOne(
      withTenantFilter(req, {
        _id: { $ne: req.params.id },
        name: {
          $regex: new RegExp(`^${escapeRegex(payload.name)}$`, "i")
        }
      })
    );

    if (duplicate) {
      return res.status(409).json({
        message: "Another menu item already uses that name"
      });
    }

    const updated = await MenuItem.findOneAndUpdate(
      withTenantDocFilter(req, req.params.id),
      payload,
      {
        new: true,
        runValidators: true
      }
    );

    if (!updated) {
      return res.status(404).json({ message: "Menu item not found" });
    }

    await maybeSyncCloudKitchenAvailability(req, {
      menuItemIds: [updated._id]
    });

    const refreshed = await MenuItem.findById(updated._id);
    res.json(serializeMenuItem(refreshed || updated));
  } catch (err) {
    return res.serverError(err);
  }
});

router.delete("/:id", requirePermission("menu.manage"), async (req, res) => {
  try {
    const deleted = await MenuItem.findOneAndDelete(withTenantDocFilter(req, req.params.id));

    if (!deleted) {
      return res.status(404).json({ message: "Menu item not found" });
    }

    res.json({ message: "Menu item deleted" });
  } catch (err) {
    return res.serverError(err);
  }
});

module.exports = router;
