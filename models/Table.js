const mongoose = require("mongoose");

const TableSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true
    },
    code: {
      type: String,
      required: true,
      trim: true
    },
    displayName: {
      type: String,
      default: "",
      trim: true
    },
    capacity: {
      type: Number,
      default: 2,
      min: 1
    },
    status: {
      type: String,
      enum: ["AVAILABLE", "OCCUPIED", "RESERVED", "CLEANING"],
      default: "AVAILABLE"
    },
    currentOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null
    },
    currentCustomerName: {
      type: String,
      default: "",
      trim: true
    },
    notes: {
      type: String,
      default: "",
      trim: true
    }
  },
  { timestamps: true }
);

TableSchema.index({ restaurantId: 1, code: 1 }, { unique: true });
TableSchema.index({ restaurantId: 1, status: 1 });

module.exports = mongoose.model("Table", TableSchema);
