const mongoose = require("mongoose");

const WastageLogSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true
    },
    ingredientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Ingredient",
      default: null
    },
    itemId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null
    },
    type: {
      type: String,
      enum: ["raw", "prep", "packaging"],
      default: "raw"
    },
    ingredientName: {
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
    reason: {
      type: String,
      default: "",
      trim: true
    },
    estimatedCost: {
      type: Number,
      default: 0,
      min: 0
    },
    value: {
      type: Number,
      default: 0,
      min: 0
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    }
  },
  { timestamps: true }
);

WastageLogSchema.pre("validate", function syncWastageAliases(next) {
  this.itemId = this.itemId || this.ingredientId || null;
  this.ingredientId = this.ingredientId || (this.type === "raw" ? this.itemId : null);
  const value = Number(this.value ?? this.estimatedCost ?? 0);
  this.value = Number.isFinite(value) ? Math.max(0, value) : 0;
  this.estimatedCost = this.value;
  next();
});

WastageLogSchema.index({ restaurantId: 1, createdAt: -1 });
WastageLogSchema.index({ restaurantId: 1, ingredientId: 1, createdAt: -1 });
WastageLogSchema.index({ restaurantId: 1, type: 1, createdAt: -1 });

module.exports = mongoose.model("WastageLog", WastageLogSchema);
