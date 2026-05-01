const mongoose = require("mongoose");

const TrendSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Restaurant",
      default: null
    },
    area: {
      type: String,
      required: true,
      trim: true
    },
    trendingItems: {
      type: [String],
      default: []
    }
  },
  { timestamps: true }
);

TrendSchema.index({ area: 1, createdAt: -1 });
TrendSchema.index({ restaurantId: 1, createdAt: -1 });

module.exports = mongoose.model("Trend", TrendSchema);
