const mongoose = require("mongoose");

const activityLogSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Restaurant",
      index: true,
      default: null
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },
    userName: {
      type: String,
      default: "",
      trim: true
    },
    role: {
      type: String,
      default: "",
      trim: true
    },
    action: {
      type: String,
      required: true,
      trim: true
    },
    module: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({})
    }
  },
  { timestamps: true }
);

activityLogSchema.index({ restaurantId: 1, createdAt: -1 });
activityLogSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("ActivityLog", activityLogSchema);
