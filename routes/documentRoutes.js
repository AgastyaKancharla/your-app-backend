const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const Document = require("../models/Document");
const authorizeRoles = require("../middleware/authorizeRoles");
const { DOCUMENT_VIEW_ROLES } = require("../utils/accessControl");
const {
  getTenantRestaurantId,
  withTenantFilter,
  withTenantDocFilter
} = require("../utils/tenantScope");
const {
  getCurrentPlanLimits,
  buildUpgradeResponse
} = require("../middleware/planLimitMiddleware");
const { ensureStorageDir } = require("../utils/storagePaths");

const router = express.Router();

const documentsDir = ensureStorageDir("documents");

const allowedExtensions = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".csv",
  ".txt",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp"
]);

const allowedMimeTypes = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "application/csv",
  "text/plain",
  "image/png",
  "image/jpeg",
  "image/webp"
]);

const storage = multer.diskStorage({
  destination: (_, __, cb) => {
    cb(null, documentsDir);
  },
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const safeExt = allowedExtensions.has(ext) ? ext : "";
    const randomToken = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `doc-${randomToken}${safeExt}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 20 * 1024 * 1024
  }
});

const getFileTitle = (bodyTitle, fileName) => {
  const explicitTitle = String(bodyTitle || "").trim();
  if (explicitTitle) {
    return explicitTitle;
  }

  const baseName = path.basename(fileName || "", path.extname(fileName || ""));
  return baseName || "Untitled";
};

const normalizeCategory = (value = "") => {
  const normalized = String(value || "GENERAL").trim().toUpperCase();
  return normalized || "GENERAL";
};

const isAllowedFile = (file) => {
  const ext = path.extname(file?.originalname || "").toLowerCase();
  const mime = String(file?.mimetype || "").toLowerCase();
  return allowedExtensions.has(ext) || allowedMimeTypes.has(mime);
};

const removeUploadedFileSafely = (filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
};

router.get("/", authorizeRoles(DOCUMENT_VIEW_ROLES), async (req, res) => {
  try {
    const documents = await Document.find(withTenantFilter(req)).sort({ createdAt: -1 });
    res.json(documents);
  } catch (err) {
    return res.serverError(err);
  }
});

router.post("/", authorizeRoles(DOCUMENT_VIEW_ROLES), (req, res) => {
  upload.single("file")(req, res, async (err) => {
    try {
      const restaurantId = getTenantRestaurantId(req);

      if (err) {
        if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({ message: "File size cannot exceed 20MB" });
        }

        return res.status(400).json({ message: err.message || "Unable to upload file" });
      }

      if (!req.file) {
        return res.status(400).json({ message: "Please choose a file to upload" });
      }

      if (!isAllowedFile(req.file)) {
        removeUploadedFileSafely(req.file.path);

        return res.status(400).json({
          message: "Unsupported file type. Use PDF, DOC, XLS, CSV, text, or image files."
        });
      }

      const limits = getCurrentPlanLimits(req);
      const maxSingleDocumentBytes = Number(limits.maxSingleDocumentBytes || 20 * 1024 * 1024);
      const maxDocuments = Number(limits.maxDocuments || 0);
      const maxDocumentStorageBytes = Number(limits.maxDocumentStorageBytes || 0);

      if (maxSingleDocumentBytes > 0 && req.file.size > maxSingleDocumentBytes) {
        removeUploadedFileSafely(req.file.path);
        return res.status(403).json(
          buildUpgradeResponse({
            req,
            feature: "documentUploadSize",
            message: `File too large for your plan. Max allowed is ${Math.floor(maxSingleDocumentBytes / (1024 * 1024))} MB.`,
            requiredPlan: "PRO",
            limit: maxSingleDocumentBytes,
            current: req.file.size
          })
        );
      }

      const tenantFilter = withTenantFilter(req);
      const usage = await Document.aggregate([
        { $match: tenantFilter },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            totalSize: { $sum: { $ifNull: ["$size", 0] } }
          }
        }
      ]);

      const currentCount = Number(usage[0]?.count || 0);
      const currentStorageBytes = Number(usage[0]?.totalSize || 0);

      if (maxDocuments > 0 && currentCount + 1 > maxDocuments) {
        removeUploadedFileSafely(req.file.path);
        return res.status(403).json(
          buildUpgradeResponse({
            req,
            feature: "documentCount",
            message: `Document limit reached (${maxDocuments} files). Upgrade your plan for more storage.`,
            requiredPlan: "BASIC",
            limit: maxDocuments,
            current: currentCount
          })
        );
      }

      if (
        maxDocumentStorageBytes > 0 &&
        currentStorageBytes + req.file.size > maxDocumentStorageBytes
      ) {
        removeUploadedFileSafely(req.file.path);
        return res.status(403).json(
          buildUpgradeResponse({
            req,
            feature: "documentStorage",
            message: "Document storage limit reached. Upgrade your plan for more storage.",
            requiredPlan: "PRO",
            limit: maxDocumentStorageBytes,
            current: currentStorageBytes + req.file.size
          })
        );
      }

      const doc = await Document.create({
        restaurantId,
        uploadedBy: req.user?.userId || null,
        title: getFileTitle(req.body?.title, req.file.originalname),
        category: normalizeCategory(req.body?.category),
        description: String(req.body?.description || "").trim(),
        originalName: req.file.originalname,
        storedName: req.file.filename,
        mimeType: req.file.mimetype,
        size: req.file.size
      });

      res.status(201).json(doc);
    } catch (error) {
      removeUploadedFileSafely(req.file?.path);

      return res.serverError(error);
    }
  });
});

router.get(
  "/:id/download",
  authorizeRoles(DOCUMENT_VIEW_ROLES),
  async (req, res) => {
  try {
    const doc = await Document.findOne(withTenantDocFilter(req, req.params.id));

    if (!doc) {
      return res.status(404).json({ message: "Document not found" });
    }

    const absolutePath = path.join(documentsDir, doc.storedName);

    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ message: "Document file is missing on server" });
    }

    return res.download(absolutePath, doc.originalName);
  } catch (err) {
    return res.serverError(err);
  }
});

router.delete(
  "/:id",
  authorizeRoles(DOCUMENT_VIEW_ROLES),
  async (req, res) => {
  try {
    const doc = await Document.findOneAndDelete(withTenantDocFilter(req, req.params.id));

    if (!doc) {
      return res.status(404).json({ message: "Document not found" });
    }

    const absolutePath = path.join(documentsDir, doc.storedName);
    if (fs.existsSync(absolutePath)) {
      fs.unlinkSync(absolutePath);
    }

    return res.json({ message: "Document deleted" });
  } catch (err) {
    return res.serverError(err);
  }
});

module.exports = router;
