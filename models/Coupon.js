const mongoose = require("mongoose");

const CouponSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true
    },
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true
    },
    title: {
      type: String,
      default: "",
      trim: true
    },
    discountType: {
      type: String,
      enum: ["PERCENTAGE", "FLAT"],
      default: "PERCENTAGE"
    },
    discountValue: {
      type: Number,
      default: 0,
      min: 0
    },
    minOrderValue: {
      type: Number,
      default: 0,
      min: 0
    },
    expiresAt: {
      type: Date,
      default: null
    },
    isActive: {
      type: Boolean,
      default: true
    },
    usageCount: {
      type: Number,
      default: 0,
      min: 0
    }
  },
  { timestamps: true }
);

CouponSchema.index({ restaurantId: 1, code: 1 }, { unique: true });
CouponSchema.index({ restaurantId: 1, isActive: 1, expiresAt: 1 });

module.exports = mongoose.model("Coupon", CouponSchema);
