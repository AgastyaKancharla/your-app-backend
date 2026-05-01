const mongoose = require("mongoose");

const ExpenseSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true
    },
    category: {
      type: String,
      required: true,
      trim: true
    },
    amount: {
      type: Number,
      required: true,
      min: 0
    },
    description: {
      type: String,
      default: "",
      trim: true
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    }
  },
  { timestamps: true }
);

ExpenseSchema.index({ restaurantId: 1, createdAt: -1 });
ExpenseSchema.index({ restaurantId: 1, category: 1, createdAt: -1 });

module.exports = mongoose.model("Expense", ExpenseSchema);
