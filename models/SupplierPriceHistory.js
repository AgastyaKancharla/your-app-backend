const mongoose = require("mongoose");

const SupplierPriceHistorySchema = new mongoose.Schema(
  {
    restaurantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true,
      index: true
    },
    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      default: null
    },
    itemId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null
    },
    itemType: {
      type: String,
      enum: ["raw_material", "prep_item", "packaging"],
      required: true
    },
    itemName: {
      type: String,
      default: "",
      trim: true
    },
    unit: {
      type: String,
      default: "unit",
      trim: true
    },
    unitPrice: {
      type: Number,
      required: true,
      min: 0
    },
    purchaseOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PurchaseOrder",
      default: null
    },
    receivedAt: {
      type: Date,
      default: Date.now
    }
  },
  { timestamps: true }
);

SupplierPriceHistorySchema.index({ restaurantId: 1, supplierId: 1, itemId: 1, createdAt: -1 });
SupplierPriceHistorySchema.index({ restaurantId: 1, itemName: 1, createdAt: -1 });

module.exports = mongoose.model("SupplierPriceHistory", SupplierPriceHistorySchema);
