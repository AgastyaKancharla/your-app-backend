const mongoose = require("mongoose");

const InventoryAlertSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true,
      index: true
    },
    type: {
      type: String,
      enum: [
        "low_stock",
        "critical_low_stock",
        "negative_stock",
        "expiring_soon",
        "abnormal_variance",
        "excessive_wastage",
        "excessive_overrides",
        "purchase_recommendation"
      ],
      required: true
    },
    severity: {
      type: String,
      enum: ["info", "warning", "critical"],
      default: "warning"
    },
    itemId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null
    },
    itemType: {
      type: String,
      enum: ["raw_material", "prep_item", "packaging", ""],
      default: ""
    },
    title: {
      type: String,
      required: true,
      trim: true
    },
    message: {
      type: String,
      default: "",
      trim: true
    },
    acknowledged: {
      type: Boolean,
      default: false
    },
    acknowledgedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },
    acknowledgedAt: {
      type: Date,
      default: null
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    }
  },
  { timestamps: true }
);

InventoryAlertSchema.index({ restaurantId: 1, acknowledged: 1, createdAt: -1 });
InventoryAlertSchema.index({ restaurantId: 1, type: 1, createdAt: -1 });

module.exports = mongoose.model("InventoryAlert", InventoryAlertSchema);
