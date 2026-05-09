const mongoose = require("mongoose");
const {
  ALL_ORDER_STATUS_VALUES,
  ORDER_STATUSES
} = require("../utils/accessControl");

const OrderSchema = new mongoose.Schema({
  restaurantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Restaurant",
    required: true
  },

  invoiceNumber: {
    type: String,
    default: ""
  },

  items: [
    {
      menuItemId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "MenuItem",
        default: null
      },
      menuId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "MenuItem",
        default: null
      },
      name: {
        type: String,
        required: true
      },
      displayName: {
        type: String,
        default: ""
      },
      variant: {
        name: {
          type: String,
          default: ""
        },
        price: {
          type: Number,
          default: 0
        }
      },
      variantName: {
        type: String,
        default: ""
      },
      addOns: [
        {
          name: {
            type: String,
            default: ""
          },
          price: {
            type: Number,
            default: 0
          }
        }
      ],
      addons: [
        {
          name: {
            type: String,
            default: ""
          },
          price: {
            type: Number,
            default: 0
          }
        }
      ],
      notes: {
        type: String,
        default: ""
      },
      image: {
        type: String,
        default: ""
      },
      quantity: {
        type: Number,
        required: true
      },
      price: {
        type: Number,
        required: true
      },
      recipeVersionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "RecipeVersion",
        default: null
      },
      costSnapshot: {
        recipeCost: {
          type: Number,
          default: 0
        },
        unitCost: {
          type: Number,
          default: 0
        },
        totalCost: {
          type: Number,
          default: 0
        },
        ingredients: [
          {
            ingredientId: {
              type: mongoose.Schema.Types.ObjectId,
              default: null
            },
            ingredientType: {
              type: String,
              default: ""
            },
            quantity: {
              type: Number,
              default: 0
            },
            unit: {
              type: String,
              default: ""
            },
            costPerUnit: {
              type: Number,
              default: 0
            },
            totalCost: {
              type: Number,
              default: 0
            }
          }
        ]
      }
    }
  ],

  subtotal: {
    type: Number,
    default: 0
  },

  gstTotal: {
    type: Number,
    default: 0
  },

  packagingCharge: {
    type: Number,
    default: 0
  },

  discount: {
    type: Number,
    default: 0
  },

  grandTotal: {
    type: Number,
    default: 0
  },

  paymentMode: {
    type: String,
    enum: ["CASH", "UPI", "CARD", "ZOMATO", "SWIGGY", "OTHER"],
    default: "CASH"
  },
  paymentType: {
    type: String,
    default: "CASH"
  },

  orderChannel: {
    type: String,
    enum: ["DIRECT", "WEBSITE", "SWIGGY", "ZOMATO", "MAGICPIN", "OTHER_APP", "WALK_IN"],
    default: "DIRECT"
  },

  externalOrderId: {
    type: String,
    default: "",
    trim: true
  },

  integrationMeta: {
    source: {
      type: String,
      default: "",
      trim: true
    },
    sourceLabel: {
      type: String,
      default: "",
      trim: true
    },
    origin: {
      type: String,
      default: "",
      trim: true
    },
    websiteUrl: {
      type: String,
      default: "",
      trim: true
    },
    storeId: {
      type: String,
      default: "",
      trim: true
    },
    notes: {
      type: String,
      default: "",
      trim: true
    }
  },

  commissionDeduction: {
    type: Number,
    default: 0
  },

  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Customer",
    default: null
  },

  customerName: {
    type: String,
    default: ""
  },

  customerPhone: {
    type: String,
    default: ""
  },
  customer: {
    name: {
      type: String,
      default: ""
    },
    phone: {
      type: String,
      default: ""
    }
  },

  couponCode: {
    type: String,
    default: ""
  },

  couponDiscount: {
    type: Number,
    default: 0
  },

  loyaltyPointsEarned: {
    type: Number,
    default: 0
  },

  referralCodeApplied: {
    type: String,
    default: ""
  },

  businessType: {
    type: String,
    enum: ["RESTAURANT", "CLOUD_KITCHEN"],
    default: "RESTAURANT"
  },

  serviceType: {
    type: String,
    enum: ["DINE_IN", "DELIVERY", "TAKEAWAY"],
    default: "DELIVERY"
  },
  orderType: {
    type: String,
    enum: ["DELIVERY", "TAKEAWAY"],
    default: "DELIVERY"
  },

  tableCode: {
    type: String,
    default: ""
  },
  platform: {
    type: String,
    default: "MANUAL"
  },
  inventoryOverride: {
    reason: {
      type: String,
      default: "",
      trim: true
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },
    timestamp: {
      type: Date,
      default: null
    },
    shortages: {
      type: [mongoose.Schema.Types.Mixed],
      default: []
    }
  },
  expectedPrepTimeMinutes: {
    type: Number,
    default: 15,
    min: 1
  },

  delivery: {
    partnerName: {
      type: String,
      default: ""
    },
    partnerPhone: {
      type: String,
      default: ""
    },
    etaMinutes: {
      type: Number,
      default: 0
    },
    notes: {
      type: String,
      default: ""
    },
    assignedAt: {
      type: Date,
      default: null
    },
    deliveredAt: {
      type: Date,
      default: null
    }
  },

  netProfit: {
    type: Number,
    default: 0
  },

  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null
  },

  totalAmount: {
    type: Number,
    required: true
  },

  status: {
    type: String,
    enum: ALL_ORDER_STATUS_VALUES,
    default: ORDER_STATUSES[0]
  },

  statusTimeline: [
    {
      _id: false,
      status: {
        type: String,
        enum: ALL_ORDER_STATUS_VALUES,
        default: ORDER_STATUSES[0]
      },
      changedAt: {
        type: Date,
        default: Date.now
      },
      note: {
        type: String,
        default: ""
      },
      changedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null
      }
    }
  ],

  readyAt: {
    type: Date,
    default: null
  },

  completedAt: {
    type: Date,
    default: null
  },
  dispatchedAt: {
    type: Date,
    default: null
  },
  cancelledAt: {
    type: Date,
    default: null
  },

  createdAt: {
    type: Date,
    default: Date.now
  }
});

OrderSchema.pre("validate", function syncOrderCompatibility(next) {
  this.items = Array.isArray(this.items)
    ? this.items.map((item) => {
        const menuItemId = item.menuItemId || item.menuId || null;
        const addons = Array.isArray(item.addons)
          ? item.addons
          : Array.isArray(item.addOns)
            ? item.addOns
            : [];

        return {
          ...item,
          menuItemId,
          menuId: menuItemId,
          variant: {
            name: String(item.variant?.name || item.variantName || "").trim(),
            price: Number(item.variant?.price || 0)
          },
          variantName: String(item.variant?.name || item.variantName || "").trim(),
          addons,
          addOns: addons,
          notes: String(item.notes || "").trim()
        };
      })
    : [];

  const normalizedServiceType = String(this.serviceType || this.orderType || "DELIVERY")
    .trim()
    .toUpperCase();
  const normalizedBusinessType = String(this.businessType || "RESTAURANT")
    .trim()
    .toUpperCase();
  const normalizedOrderType =
    normalizedServiceType === "TAKEAWAY" ? "TAKEAWAY" : "DELIVERY";
  const customerName = String(this.customer?.name || this.customerName || "").trim();
  const customerPhone = String(this.customer?.phone || this.customerPhone || "").trim();
  const paymentType = String(this.paymentType || this.paymentMode || "CASH")
    .trim()
    .toUpperCase();

  this.customerName = customerName;
  this.customerPhone = customerPhone;
  this.customer = {
    name: customerName,
    phone: customerPhone
  };
  this.businessType = normalizedBusinessType === "CLOUD_KITCHEN" ? "CLOUD_KITCHEN" : "RESTAURANT";
  this.paymentType = paymentType;
  this.paymentMode = paymentType;
  this.serviceType =
    this.businessType === "CLOUD_KITCHEN"
      ? normalizedOrderType
      : ["DINE_IN", "TAKEAWAY", "DELIVERY"].includes(normalizedServiceType)
        ? normalizedServiceType
        : "DELIVERY";
  this.orderType = normalizedOrderType;
  this.packagingCharge = Number.isFinite(Number(this.packagingCharge))
    ? Math.max(0, Number(this.packagingCharge))
    : 0;
  this.gstTotal = Number.isFinite(Number(this.gstTotal)) ? Math.max(0, Number(this.gstTotal)) : 0;
  this.grandTotal = Number.isFinite(Number(this.grandTotal))
    ? Math.max(0, Number(this.grandTotal))
    : Math.max(0, Number(this.totalAmount || 0));
  this.totalAmount = Number.isFinite(Number(this.totalAmount))
    ? Math.max(0, Number(this.totalAmount))
    : this.grandTotal;

  if (!Array.isArray(this.statusTimeline)) {
    this.statusTimeline = [];
  }

  if (
    this.businessType === "CLOUD_KITCHEN" &&
    String(this.status || "").toUpperCase() === "DISPATCHED"
  ) {
    this.dispatchedAt = this.dispatchedAt || this.completedAt || new Date();
    this.completedAt = this.completedAt || this.dispatchedAt;
    if (!this.delivery) {
      this.delivery = {};
    }
    this.delivery.deliveredAt = this.delivery.deliveredAt || this.dispatchedAt;
  }

  if (!this.statusTimeline.length && this.status) {
    this.statusTimeline = [
      {
        status: this.status,
        changedAt: this.createdAt || new Date(),
        changedBy: this.createdBy || null
      }
    ];
  }

  if (!String(this.platform || "").trim()) {
    const channel = String(this.orderChannel || this.paymentMode || "DIRECT")
      .trim()
      .toUpperCase();
    this.platform = ["SWIGGY", "ZOMATO", "MAGICPIN"].includes(channel)
      ? channel
      : channel === "DIRECT" || channel === "WALK_IN"
        ? "MANUAL"
        : channel;
  }

  next();
});

OrderSchema.index({ restaurantId: 1, createdAt: -1 });
OrderSchema.index({ restaurantId: 1, invoiceNumber: 1 });
OrderSchema.index({ restaurantId: 1, paymentMode: 1, createdAt: -1 });
OrderSchema.index({ restaurantId: 1, orderChannel: 1, createdAt: -1 });
OrderSchema.index({ restaurantId: 1, status: 1, createdAt: -1 });
OrderSchema.index({ restaurantId: 1, businessType: 1, status: 1, createdAt: -1 });
OrderSchema.index({ restaurantId: 1, externalOrderId: 1, orderChannel: 1 });

module.exports = mongoose.model("Order", OrderSchema);
