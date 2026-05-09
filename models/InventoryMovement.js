const mongoose = require("mongoose");

const InventoryMovementSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true,
      index: true
    },
    itemId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true
    },
    itemType: {
      type: String,
      enum: ["raw_material", "prep_item", "packaging"],
      required: true
    },
    movementType: {
      type: String,
      enum: [
        "purchase",
        "order_deduction",
        "wastage",
        "adjustment",
        "prep_consumption",
        "prep_production",
        "reconciliation_adjustment"
      ],
      required: true
    },
    quantity: {
      type: Number,
      required: true
    },
    unit: {
      type: String,
      default: "unit",
      trim: true
    },
    costPerUnit: {
      type: Number,
      default: 0,
      min: 0
    },
    totalCost: {
      type: Number,
      default: 0,
      min: 0
    },
    referenceType: {
      type: String,
      enum: ["order", "purchase_order", "wastage", "reconciliation", "prep_batch", "adjustment", ""],
      default: ""
    },
    referenceId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },
    notes: {
      type: String,
      default: "",
      trim: true
    },
    stockBefore: {
      type: Number,
      default: 0
    },
    stockAfter: {
      type: Number,
      default: 0
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    }
  },
  {
    collection: "inventory_movements",
    timestamps: { createdAt: true, updatedAt: false }
  }
);

InventoryMovementSchema.pre("validate", function syncMovementCost(next) {
  const quantity = Number(this.quantity || 0);
  const costPerUnit = Number(this.costPerUnit || 0);
  const totalCost = Number(this.totalCost || Math.abs(quantity) * costPerUnit);
  this.quantity = Number.isFinite(quantity) ? quantity : 0;
  this.costPerUnit = Number.isFinite(costPerUnit) ? Math.max(0, costPerUnit) : 0;
  this.totalCost = Number.isFinite(totalCost) ? Math.max(0, totalCost) : 0;
  next();
});

InventoryMovementSchema.index({ itemId: 1 });
InventoryMovementSchema.index({ movementType: 1 });
InventoryMovementSchema.index({ createdAt: -1 });
InventoryMovementSchema.index({ restaurantId: 1, itemId: 1, createdAt: -1 });
InventoryMovementSchema.index({ restaurantId: 1, itemType: 1, createdAt: -1 });
InventoryMovementSchema.index({ restaurantId: 1, movementType: 1, createdAt: -1 });
InventoryMovementSchema.index({ restaurantId: 1, referenceType: 1, referenceId: 1 });

module.exports = mongoose.model("InventoryMovement", InventoryMovementSchema);
