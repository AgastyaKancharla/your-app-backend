const mongoose = require("mongoose")

const MessageSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      default: null
    },
    phone: {
      type: String,
      required: true,
      trim: true
    },
    text: {
      type: String,
      default: "",
      trim: true
    },
    from: {
      type: String,
      enum: ["customer", "business"],
      required: true
    },
    provider: {
      type: String,
      default: "whatsapp",
      trim: true
    },
    messageId: {
      type: String,
      default: "",
      trim: true
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    }
  },
  { timestamps: true }
)

MessageSchema.index({ restaurantId: 1, customerId: 1, createdAt: -1 })
MessageSchema.index({ restaurantId: 1, phone: 1, createdAt: -1 })
MessageSchema.index({ provider: 1, messageId: 1 })

module.exports = mongoose.model("Message", MessageSchema)
