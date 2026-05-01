const mongoose = require("mongoose");

const PurchaseOrderLineSchema = new mongoose.Schema(
  {
    itemId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null
    },
    type: {
      type: String,
      enum: ["raw", "prep", "packaging"],
      default: "raw"
    },
    ingredientName: {
      type: String,
      required: true,
      trim: true
    },
    quantity: {
      type: Number,
      required: true,
      min: 0
    },
    unit: {
      type: String,
      default: "kg",
      trim: true
    },
    unitPrice: {
      type: Number,
      default: 0,
      min: 0
    },
    lineTotal: {
      type: Number,
      default: 0,
      min: 0
    },
    qty: {
      type: Number,
      default: 0,
      min: 0
    },
    cost: {
      type: Number,
      default: 0,
      min: 0
    }
  },
  { _id: false }
);

const PurchaseOrderSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true
    },
    poNumber: {
      type: String,
      default: ""
    },
    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      default: null
    },
    supplierName: {
      type: String,
      default: "",
      trim: true
    },
    lines: {
      type: [PurchaseOrderLineSchema],
      default: []
    },
    items: {
      type: [PurchaseOrderLineSchema],
      default: []
    },
    subtotal: {
      type: Number,
      default: 0,
      min: 0
    },
    taxAmount: {
      type: Number,
      default: 0,
      min: 0
    },
    totalAmount: {
      type: Number,
      default: 0,
      min: 0
    },
    expectedDate: {
      type: Date,
      default: null
    },
    status: {
      type: String,
      enum: [
        "DRAFT",
        "ORDERED",
        "RECEIVED",
        "CANCELLED",
        "OPEN",
        "CONFIRMED",
        "IN_TRANSIT",
        "DELIVERED"
      ],
      default: "DRAFT"
    },
    paymentStatus: {
      type: String,
      enum: ["UNPAID", "PARTIAL", "PAID"],
      default: "UNPAID"
    },
    notes: {
      type: String,
      default: "",
      trim: true
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },
    receivedAt: {
      type: Date,
      default: null
    },
    expectedDelivery: {
      type: Date,
      default: null
    }
  },
  { timestamps: true }
);

PurchaseOrderSchema.pre("validate", function syncPurchaseOrderAliases(next) {
  const sourceLines = Array.isArray(this.items) && this.items.length ? this.items : this.lines;

  const normalizedLines = (Array.isArray(sourceLines) ? sourceLines : [])
    .map((line) => {
      const quantity = Number(line.quantity ?? line.qty ?? 0);
      const unitPrice = Number(line.unitPrice ?? line.cost ?? 0);
      const lineTotal = Number(line.lineTotal ?? quantity * unitPrice);

      return {
        itemId: line.itemId || null,
        type: ["raw", "prep", "packaging"].includes(String(line.type || "").toLowerCase())
          ? String(line.type).toLowerCase()
          : "raw",
        ingredientName: String(line.ingredientName || line.itemName || "").trim(),
        quantity: Number.isFinite(quantity) ? Math.max(0, quantity) : 0,
        qty: Number.isFinite(quantity) ? Math.max(0, quantity) : 0,
        unit: String(line.unit || "kg").trim() || "kg",
        unitPrice: Number.isFinite(unitPrice) ? Math.max(0, unitPrice) : 0,
        cost: Number.isFinite(unitPrice) ? Math.max(0, unitPrice) : 0,
        lineTotal: Number.isFinite(lineTotal) ? Math.max(0, lineTotal) : 0
      };
    })
    .filter((line) => line.ingredientName && line.quantity > 0);

  this.lines = normalizedLines;
  this.items = normalizedLines;
  this.expectedDelivery = this.expectedDelivery || this.expectedDate || null;
  this.expectedDate = this.expectedDate || this.expectedDelivery || null;

  if (this.status === "DELIVERED") {
    this.receivedAt = this.receivedAt || new Date();
  }

  next();
});

PurchaseOrderSchema.index({ restaurantId: 1, poNumber: 1 }, { unique: true });
PurchaseOrderSchema.index({ restaurantId: 1, status: 1, createdAt: -1 });
PurchaseOrderSchema.index({ restaurantId: 1, supplierId: 1, createdAt: -1 });

module.exports = mongoose.model("PurchaseOrder", PurchaseOrderSchema);
