const mongoose = require("mongoose");

const ReconciliationItemSchema = new mongoose.Schema(
  {
    itemId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true
    },
    itemType: {
      type: String,
      enum: ["raw_material", "prep_item", "packaging"],
      required: true
    },
    itemName: {
      type: String,
      default: "",
      trim: true
    },
    unit: {
      type: String,
      default: "unit",
      trim: true
    },
    expectedQty: {
      type: Number,
      default: 0
    },
    countedQty: {
      type: Number,
      default: null
    },
    variance: {
      type: Number,
      default: 0
    },
    notes: {
      type: String,
      default: "",
      trim: true
    }
  },
  { _id: false }
);

const ReconciliationSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true,
      index: true
    },
    date: {
      type: Date,
      required: true
    },
    items: {
      type: [ReconciliationItemSchema],
      default: []
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending"
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },
    approvedAt: {
      type: Date,
      default: null
    },
    rejectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },
    rejectedAt: {
      type: Date,
      default: null
    },
    notes: {
      type: String,
      default: "",
      trim: true
    }
  },
  { timestamps: true }
);

ReconciliationSchema.pre("validate", function syncVariance(next) {
  this.items = (Array.isArray(this.items) ? this.items : []).map((item) => {
    const expectedQty = Number(item.expectedQty || 0);
    const countedQty = Number(item.countedQty ?? expectedQty);
    return {
      ...item,
      expectedQty,
      countedQty,
      variance: Number((countedQty - expectedQty).toFixed(4))
    };
  });
  next();
});

ReconciliationSchema.index({ restaurantId: 1, date: -1 });
ReconciliationSchema.index({ restaurantId: 1, status: 1, date: -1 });

module.exports = mongoose.model("Reconciliation", ReconciliationSchema);
