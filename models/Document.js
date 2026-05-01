const mongoose = require("mongoose");

const DocumentSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    },
    title: {
      type: String,
      required: true,
      trim: true
    },
    category: {
      type: String,
      default: "GENERAL",
      trim: true
    },
    description: {
      type: String,
      default: "",
      trim: true
    },
    originalName: {
      type: String,
      required: true
    },
    storedName: {
      type: String,
      required: true
    },
    mimeType: {
      type: String,
      default: ""
    },
    size: {
      type: Number,
      default: 0
    }
  },
  { timestamps: true }
);

DocumentSchema.index({ restaurantId: 1, createdAt: -1 });

module.exports = mongoose.model("Document", DocumentSchema);
