const mongoose = require("mongoose");

const FavoriteDishSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      default: "",
      trim: true
    },
    orderCount: {
      type: Number,
      default: 0,
      min: 0
    }
  },
  { _id: false }
);

const OrderHistoryItemSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      default: "",
      trim: true
    },
    displayName: {
      type: String,
      default: "",
      trim: true
    },
    quantity: {
      type: Number,
      default: 0,
      min: 0
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
    }
  },
  { _id: false }
);

const OrderHistorySchema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null
    },
    orderedAt: {
      type: Date,
      default: null
    },
    totalAmount: {
      type: Number,
      default: 0,
      min: 0
    },
    invoiceNumber: {
      type: String,
      default: "",
      trim: true
    },
    orderStatus: {
      type: String,
      default: "",
      trim: true
    },
    serviceType: {
      type: String,
      default: "",
      trim: true
    },
    paymentMode: {
      type: String,
      default: "",
      trim: true
    },
    items: {
      type: [String],
      default: []
    },
    itemDetails: {
      type: [OrderHistoryItemSchema],
      default: []
    }
  },
  { _id: false }
);

const CustomerSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true
    },
    name: {
      type: String,
      default: "",
      trim: true
    },
    phone: {
      type: String,
      required: true,
      trim: true
    },
    source: {
      type: String,
      default: "manual",
      trim: true
    },
    email: {
      type: String,
      default: "",
      trim: true,
      lowercase: true
    },
    segment: {
      type: String,
      default: "",
      trim: true
    },
    platform: {
      type: String,
      default: "",
      trim: true
    },
    status: {
      type: String,
      default: "",
      trim: true
    },
    tags: {
      type: [String],
      default: []
    },
    address: {
      type: String,
      default: "",
      trim: true
    },
    city: {
      type: String,
      default: "",
      trim: true
    },
    state: {
      type: String,
      default: "",
      trim: true
    },
    pinCode: {
      type: String,
      default: "",
      trim: true
    },
    latitude: {
      type: Number,
      default: null,
      min: -90,
      max: 90
    },
    longitude: {
      type: Number,
      default: null,
      min: -180,
      max: 180
    },
    orderCount: {
      type: Number,
      default: 0,
      min: 0
    },
    totalOrders: {
      type: Number,
      default: 0,
      min: 0
    },
    lifetimeValue: {
      type: Number,
      default: 0,
      min: 0
    },
    totalSpent: {
      type: Number,
      default: 0,
      min: 0
    },
    loyaltyPoints: {
      type: Number,
      default: 0,
      min: 0
    },
    favoriteDishes: {
      type: [FavoriteDishSchema],
      default: []
    },
    orderHistory: {
      type: [OrderHistorySchema],
      default: []
    },
    lastOrderAt: {
      type: Date,
      default: null
    },
    firstOrderAt: {
      type: Date,
      default: null
    },
    referralCode: {
      type: String,
      default: "",
      trim: true
    },
    referredByCode: {
      type: String,
      default: "",
      trim: true
    },
    totalReferrals: {
      type: Number,
      default: 0,
      min: 0
    },
    marketingPreferences: {
      whatsapp: {
        type: Boolean,
        default: true
      },
      sms: {
        type: Boolean,
        default: true
      }
    },
    notes: {
      type: String,
      default: "",
      trim: true
    }
  },
  { timestamps: true }
);

CustomerSchema.index({ restaurantId: 1, phone: 1 }, { unique: true });
CustomerSchema.index({ restaurantId: 1, referralCode: 1 });
CustomerSchema.index({ restaurantId: 1, lastOrderAt: -1 });

module.exports = mongoose.model("Customer", CustomerSchema);
