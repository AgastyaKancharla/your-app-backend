const mongoose = require("mongoose");

const processedWebhookEventSchema = new mongoose.Schema(
  {
    provider: {
      type: String,
      required: true,
      trim: true
    },
    eventId: {
      type: String,
      required: true,
      trim: true
    },
    processedAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    timestamps: true
  }
);

processedWebhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });

module.exports = mongoose.model("ProcessedWebhookEvent", processedWebhookEventSchema);
