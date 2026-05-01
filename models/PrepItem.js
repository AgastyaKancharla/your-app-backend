const mongoose = require("mongoose");

const RawMaterialUsageSchema = new mongoose.Schema(
  {
    materialId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Ingredient",
      required: true
    },
    materialName: {
      type: String,
      default: "",
      trim: true
    },
    qty: {
      type: Number,
      required: true,
      min: 0
    },
    unit: {
      type: String,
      default: "kg",
      trim: true
    }
  },
  { _id: false }
);

const PrepItemSchema = new mongoose.Schema(
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
    batchNo: {
      type: String,
      required: true,
      trim: true
    },
    quantity: {
      type: Number,
      required: true,
      min: 0
    },
    unit: {
      type: String,
      default: "kg",
      trim: true
    },
    cost: {
      type: Number,
      default: 0,
      min: 0
    },
    preparedAt: {
      type: Date,
      default: Date.now
    },
    expiryAt: {
      type: Date,
      default: null
    },
    status: {
      type: String,
      enum: ["ACTIVE", "LOW_STOCK", "EXPIRED", "CONSUMED"],
      default: "ACTIVE"
    },
    rawMaterialUsage: {
      type: [RawMaterialUsageSchema],
      default: []
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    }
  },
  { timestamps: true }
);

PrepItemSchema.pre("validate", function syncPrepStatus(next) {
  if (this.expiryAt && new Date(this.expiryAt).getTime() < Date.now()) {
    this.status = "EXPIRED";
  } else if (Number(this.quantity || 0) <= 0) {
    this.status = "CONSUMED";
  } else if (!this.status || this.status === "EXPIRED" || this.status === "CONSUMED") {
    this.status = "ACTIVE";
  }

  next();
});

PrepItemSchema.index({ restaurantId: 1, batchNo: 1 }, { unique: true });
PrepItemSchema.index({ restaurantId: 1, name: 1, createdAt: -1 });
PrepItemSchema.index({ restaurantId: 1, status: 1, expiryAt: 1 });

module.exports = mongoose.model("PrepItem", PrepItemSchema);
