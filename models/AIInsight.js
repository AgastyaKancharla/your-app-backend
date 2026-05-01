const mongoose = require("mongoose");

const AIInsightSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true
    },
    whatToSell: {
      type: [String],
      default: []
    },
    menuImprovements: {
      type: [String],
      default: []
    },
    pricingStrategy: {
      type: [String],
      default: []
    },
    marketingIdeas: {
      type: [String],
      default: []
    },
    campaignMessage: {
      type: String,
      default: "",
      trim: true
    }
  },
  { timestamps: true }
);

AIInsightSchema.index({ restaurantId: 1, createdAt: -1 });

module.exports = mongoose.model("AIInsight", AIInsightSchema);
