const mongoose = require("mongoose");

const PackagingSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true
    },
    name: {
      type: String,
      required: true,
      trim: true
    },
    category: {
      type: String,
      default: "Packaging",
      trim: true
    },
    unit: {
      type: String,
      default: "pcs",
      trim: true
    },
    stock: {
      type: Number,
      required: true,
      min: 0
    },
    minStock: {
      type: Number,
      default: 0,
      min: 0
    },
    costPerUnit: {
      type: Number,
      default: 0,
      min: 0
    },
    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      default: null
    },
    supplierName: {
      type: String,
      default: "",
      trim: true
    },
    image: {
      type: String,
      default: "",
      trim: true
    }
  },
  { timestamps: true }
);

PackagingSchema.index({ restaurantId: 1, name: 1 }, { unique: true });
PackagingSchema.index({ restaurantId: 1, supplierId: 1 });
PackagingSchema.index({ restaurantId: 1, stock: 1 });

module.exports = mongoose.model("Packaging", PackagingSchema);
