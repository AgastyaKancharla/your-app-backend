const mongoose = require("mongoose");
const Order = require("../models/Order");
const Customer = require("../models/Customer");
const Coupon = require("../models/Coupon");
const Recipe = require("../models/Recipe");
const Ingredient = require("../models/Ingredient");
const MenuItem = require("../models/MenuItem");
const Restaurant = require("../models/Restaurant");
const { normalizeOrderStatus } = require("../utils/accessControl");
const { isBelowMinStock } = require("../utils/unitConversion");
const { calculateIngredientDeduction } = require("../utils/recipeQuantities");
const {
  assertInventoryAvailableForItems,
  deductInventoryForItems,
  getExpectedPrepTimeMinutesForItems
} = require("./cloudKitchenOperationsService");
const { BUSINESS_TYPES, normalizeBusinessType } = require("./workspaceAccess");

const COMMISSION_RATE = {
  ZOMATO: 0.25,
  SWIGGY: 0.25,
  MAGICPIN: 0.18
};

const ORDER_CHANNELS = [
  "DIRECT",
  "WEBSITE",
  "SWIGGY",
  "ZOMATO",
  "MAGICPIN",
  "OTHER_APP",
  "WALK_IN"
];

const PAYMENT_MODES = ["CASH", "UPI", "CARD", "ZOMATO", "SWIGGY", "OTHER"];
const SERVICE_TYPES = ["DINE_IN", "DELIVERY", "TAKEAWAY"];

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeText = (value = "") => String(value || "").trim();
const normalizePhone = (value = "") => String(value || "").replace(/[^\d+]/g, "").trim();
const normalizeCouponCode = (value = "") => String(value || "").trim().toUpperCase();
const normalizeReferralCode = (value = "") => String(value || "").trim().toUpperCase();

const normalizePaymentMode = (value = "CASH") => {
  const mode = String(value || "CASH").trim().toUpperCase();
  if (PAYMENT_MODES.includes(mode)) {
    return mode;
  }
  return "OTHER";
};

const normalizePlatform = (value = "", orderChannel = "DIRECT") => {
  const explicitPlatform = String(value || "").trim().toUpperCase();
  if (explicitPlatform) {
    return explicitPlatform;
  }

  const channel = normalizeOrderChannel(orderChannel);
  if (["SWIGGY", "ZOMATO", "MAGICPIN"].includes(channel)) {
    return channel;
  }

  return "MANUAL";
};

const normalizeServiceType = (value = "DELIVERY") => {
  const type = String(value || "DELIVERY").trim().toUpperCase();
  if (SERVICE_TYPES.includes(type)) {
    return type;
  }
  return "DELIVERY";
};

const normalizeOrderChannel = (value = "DIRECT") => {
  const channel = String(value || "DIRECT").trim().toUpperCase();
  if (ORDER_CHANNELS.includes(channel)) {
    return channel;
  }
  return "DIRECT";
};

const deriveOrderChannel = ({ paymentMode, serviceType, orderChannel } = {}) => {
  const requestedChannel = normalizeOrderChannel(orderChannel);
  if (requestedChannel !== "DIRECT") {
    return requestedChannel;
  }

  const safePaymentMode = normalizePaymentMode(paymentMode);
  if (safePaymentMode === "SWIGGY") {
    return "SWIGGY";
  }
  if (safePaymentMode === "ZOMATO") {
    return "ZOMATO";
  }
  if (normalizeServiceType(serviceType) === "DINE_IN") {
    return "WALK_IN";
  }

  return "DIRECT";
};

const getStartOfDay = (value = new Date()) => {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
};

const getEndOfDay = (value = new Date()) => {
  const date = new Date(value);
  date.setHours(23, 59, 59, 999);
  return date;
};

const escapeRegex = (value = "") => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildInvoiceNumber = async (restaurantId) => {
  const now = new Date();
  const start = getStartOfDay(now);
  const end = getEndOfDay(now);
  const countToday = await Order.countDocuments({
    restaurantId,
    createdAt: { $gte: start, $lte: end }
  });

  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const serial = String(countToday + 1).padStart(4, "0");
  return `INV-${y}${m}${d}-${serial}`;
};

const buildReferralCode = ({ name, phone }) => {
  const nameChunk = String(name || "CX")
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 3)
    .toUpperCase() || "CX";
  const phoneChunk = String(phone || "").replace(/\D/g, "").slice(-4) || "0000";
  return `${nameChunk}${phoneChunk}`;
};

const buildFavoriteDishes = (existingFavorites = [], orderedItems = []) => {
  const counts = new Map(
    existingFavorites.map((dish) => [String(dish.name || ""), Number(dish.orderCount || 0)])
  );

  orderedItems.forEach((item) => {
    const name = String(item.name || "").trim();
    if (!name) {
      return;
    }

    counts.set(name, Number(counts.get(name) || 0) + Number(item.quantity || 0));
  });

  return Array.from(counts.entries())
    .map(([name, orderCount]) => ({ name, orderCount }))
    .sort((a, b) => b.orderCount - a.orderCount)
    .slice(0, 8);
};

const syncLowStockAlerts = async (restaurantId) => {
  const ingredients = await Ingredient.find({ restaurantId });
  if (!ingredients.length) {
    return;
  }

  const operations = ingredients.map((ingredient) => ({
    updateOne: {
      filter: { _id: ingredient._id },
      update: {
        $set: {
          lowStockAlert: isBelowMinStock({
            quantity: ingredient.quantity,
            unit: ingredient.unit,
            minStock: ingredient.minStock,
            minStockUnit: ingredient.minStockUnit
          })
        }
      }
    }
  }));

  await Ingredient.bulkWrite(operations, { ordered: false });
};

const applyInventoryDeductionForOrder = async (restaurantId, cleanItems) => {
  for (const item of cleanItems) {
    const recipe = await findRecipeForOrderItem(restaurantId, item);

    if (!recipe) {
      continue;
    }

    for (const ingredient of recipe.ingredients) {
      const deductionQty = calculateIngredientDeduction(ingredient, item.quantity);
      if (!deductionQty) {
        continue;
      }

      const stockItem = await findIngredientForRecipeLine(restaurantId, ingredient);
      if (!stockItem) {
        continue;
      }

      await Ingredient.findOneAndUpdate(
        { restaurantId, _id: stockItem._id },
        {
          $inc: {
            quantity: -deductionQty,
            currentStock: -deductionQty
          }
        }
      );
    }
  }

  await syncLowStockAlerts(restaurantId);
};

const findRecipeForOrderItem = async (restaurantId, item) => {
  const byMenuId = item.menuId
    ? await Recipe.findOne({ restaurantId, menuItemId: item.menuId })
    : null;

  if (byMenuId) {
    return byMenuId;
  }

  return Recipe.findOne({
    restaurantId,
    menuItem: {
      $regex: new RegExp(`^${escapeRegex(item.name)}$`, "i")
    }
  });
};

const findIngredientForRecipeLine = async (restaurantId, ingredient) => {
  if (ingredient.inventoryId) {
    const byId = await Ingredient.findOne({ restaurantId, _id: ingredient.inventoryId });
    if (byId) {
      return byId;
    }
  }

  return Ingredient.findOne({
    restaurantId,
    name: {
      $regex: new RegExp(`^${escapeRegex(ingredient.ingredientName)}$`, "i")
    }
  });
};

const assertInventoryAvailableForOrder = async (restaurantId, cleanItems) => {
  const requiredByIngredient = new Map();

  for (const item of cleanItems) {
    const recipe = await findRecipeForOrderItem(restaurantId, item);
    if (!recipe) {
      const error = new Error(`Recipe is not linked for menu item "${item.name}"`);
      error.status = 400;
      throw error;
    }

    for (const ingredient of recipe.ingredients || []) {
      const stockItem = await findIngredientForRecipeLine(restaurantId, ingredient);
      if (!stockItem) {
        const error = new Error(`Ingredient "${ingredient.ingredientName}" is missing from inventory`);
        error.status = 400;
        throw error;
      }

      const deductionQty = calculateIngredientDeduction(ingredient, item.quantity);
      if (!deductionQty) {
        continue;
      }

      const key = String(stockItem._id);
      const previous = requiredByIngredient.get(key) || {
        ingredient: stockItem,
        required: 0
      };
      previous.required += deductionQty;
      requiredByIngredient.set(key, previous);
    }
  }

  for (const { ingredient, required } of requiredByIngredient.values()) {
    const available = toNumber(ingredient.quantity);
    if (available < required) {
      const error = new Error(
        `Insufficient stock for ${ingredient.name}. Required ${required}, available ${available}.`
      );
      error.status = 409;
      throw error;
    }
  }
};

const serializeOrder = (order) => {
  const plainOrder =
    order && typeof order.toObject === "function" ? order.toObject() : { ...(order || {}) };

  return {
    ...plainOrder,
    status: normalizeOrderStatus(plainOrder.status)
  };
};

const buildCleanItems = (items = [], menuItems = []) => {
  const menuById = new Map();
  const menuByName = menuItems.reduce((acc, menu) => {
    if (menu?._id) {
      menuById.set(String(menu._id), menu);
    }
    acc[String(menu.name || "").trim().toLowerCase()] = menu;
    return acc;
  }, {});

  return items
    .filter((item) => (item?.name || item?.menuItemId || item?.menuId) && toNumber(item.quantity) > 0)
    .map((item) => {
      const requestedMenuId = String(item.menuItemId || item.menuId || "").trim();
      const safeMenuId = mongoose.Types.ObjectId.isValid(requestedMenuId) ? requestedMenuId : null;
      const menu =
        menuById.get(requestedMenuId) ||
        menuByName[String(item.name || "").trim().toLowerCase()];
      const normalizedName = String(item.name || menu?.name || "").trim();
      const requestedVariantName = normalizeText(
        item.variant?.name || item.variantName || item.variant
      );
      const menuVariants = Array.isArray(menu?.variants) ? menu.variants : [];
      const selectedVariant =
        menuVariants.find(
          (variant) =>
            normalizeText(variant?.name).toLowerCase() === requestedVariantName.toLowerCase()
        ) ||
        menuVariants.find((variant) => variant?.isDefault) ||
        menuVariants[0] ||
        null;
      const variantName = normalizeText(selectedVariant?.name || requestedVariantName);
      const variantPrice = Math.max(
        0,
        toNumber(
          item.variant?.price,
          toNumber(selectedVariant?.price, toNumber(menu?.sellingPrice ?? menu?.price))
        )
      );
      const rawAddOns = Array.isArray(item.addons)
        ? item.addons
        : Array.isArray(item.addOns)
          ? item.addOns
          : [];
      const resolvedAddOns = rawAddOns
        .map((addOn) => {
          const name =
            typeof addOn === "string"
              ? String(addOn || "").trim()
              : String(addOn?.name || "").trim();
          if (!name) {
            return null;
          }

          const matchedMenuAddOn = (Array.isArray(menu?.addOns) ? menu.addOns : []).find(
            (entry) => normalizeText(entry?.name).toLowerCase() === name.toLowerCase()
          );

          return {
            name,
            price: Math.max(
              0,
              toNumber(
                typeof addOn === "string" ? matchedMenuAddOn?.price : addOn?.price,
                toNumber(matchedMenuAddOn?.price)
              )
            )
          };
        })
        .filter(Boolean);

      const quantity = Math.max(0, toNumber(item.quantity));
      const defaultBasePrice = variantName
        ? variantPrice
        : Math.max(0, toNumber(menu?.sellingPrice ?? menu?.price));
      const derivedUnitPrice =
        defaultBasePrice + resolvedAddOns.reduce((sum, addOn) => sum + toNumber(addOn.price), 0);
      const explicitUnitPrice = toNumber(item.unitPrice ?? item.price, Number.NaN);
      const price = Math.max(
        0,
        Number.isFinite(explicitUnitPrice) ? explicitUnitPrice : derivedUnitPrice
      );
      const costPrice = Math.max(
        0,
        toNumber(item.costPrice ?? item.cost, toNumber(menu?.costPrice ?? menu?.cost))
      );
      const gstPercentage = Math.max(
        0,
        toNumber(item.gstPercentage, toNumber(menu?.gstPercentage, 5))
      );

      return {
        menuItemId: menu?._id || safeMenuId || null,
        menuId: menu?._id || safeMenuId || null,
        name: normalizedName,
        displayName:
          String(item.displayName || "").trim() ||
          (variantName ? `${normalizedName} (${variantName})` : normalizedName),
        variant: variantName
          ? {
              name: variantName,
              price: variantPrice
            }
          : null,
        variantName,
        addOns: resolvedAddOns,
        addons: resolvedAddOns,
        notes: normalizeText(item.notes),
        image: String(item.image || menu?.image || "").trim(),
        quantity,
        price,
        costPrice,
        gstPercentage,
        expectedPrepTimeMinutes: Math.max(
          0,
          toNumber(item.expectedPrepTimeMinutes, toNumber(menu?.expectedPrepTimeMinutes))
        )
      };
    });
};

const upsertCustomerForOrder = async ({
  restaurantId,
  cleanItems,
  customerName,
  customerPhone,
  referralCode,
  grossTotal,
  loyaltyPointsEarned,
  invoiceNumber,
  savedOrder,
  serviceType,
  paymentMode,
  orderChannel
}) => {
  if (!customerPhone) {
    return savedOrder;
  }

  let customer = await Customer.findOne({ restaurantId, phone: customerPhone });
  let isNewCustomer = false;
  const orderTimestamp = savedOrder.createdAt || new Date();
  const itemSummaries = cleanItems.map((item) => {
    const label = item.displayName || item.name;
    const quantity = Number(item.quantity || 0);
    return quantity > 1 ? `${label} x${quantity}` : label;
  });
  const itemDetails = cleanItems.map((item) => {
    const quantity = Number(item.quantity || 0);
    const unitPrice = Number(item.price || 0);

    return {
      name: String(item.name || "").trim(),
      displayName: String(item.displayName || item.name || "").trim(),
      quantity,
      unitPrice,
      lineTotal: Number((quantity * unitPrice).toFixed(2))
    };
  });

  if (!customer) {
    isNewCustomer = true;
    customer = new Customer({
      restaurantId,
      name: customerName,
      phone: customerPhone,
      referralCode: buildReferralCode({ name: customerName, phone: customerPhone }),
      referredByCode: referralCode
    });
  }

  customer.name = customerName || customer.name;
  customer.referralCode =
    customer.referralCode || buildReferralCode({ name: customer.name, phone: customerPhone });
  customer.orderCount = Number(customer.orderCount || 0) + 1;
  customer.totalOrders = Number(customer.totalOrders ?? customer.orderCount ?? 0) + 1;
  customer.lifetimeValue = Number(customer.lifetimeValue || 0) + grossTotal;
  customer.totalSpent = Number(customer.totalSpent ?? customer.lifetimeValue ?? 0) + grossTotal;
  customer.loyaltyPoints = Number(customer.loyaltyPoints || 0) + loyaltyPointsEarned;
  customer.firstOrderAt = customer.firstOrderAt || orderTimestamp;
  customer.lastOrderAt = orderTimestamp;
  customer.favoriteDishes = buildFavoriteDishes(customer.favoriteDishes, cleanItems);
  customer.orderHistory = [
    {
      orderId: savedOrder._id,
      orderedAt: orderTimestamp,
      totalAmount: grossTotal,
      invoiceNumber,
      orderStatus: savedOrder.status,
      serviceType,
      paymentMode,
      orderChannel,
      items: itemSummaries,
      itemDetails
    },
    ...(Array.isArray(customer.orderHistory) ? customer.orderHistory : []).filter((entry) => {
      return String(entry?.orderId || "") !== String(savedOrder._id || "");
    })
  ].slice(0, 100);

  if (isNewCustomer && referralCode) {
    const referrer = await Customer.findOne({
      restaurantId,
      referralCode,
      phone: { $ne: customerPhone }
    });

    if (referrer) {
      referrer.totalReferrals = Number(referrer.totalReferrals || 0) + 1;
      referrer.loyaltyPoints = Number(referrer.loyaltyPoints || 0) + 25;
      await referrer.save();
    }
  }

  await customer.save();
  savedOrder.customerId = customer._id;
  await savedOrder.save();
  return savedOrder;
};

const createOrderRecord = async ({
  restaurantId,
  payload = {},
  createdBy = null,
  requestedChannel = "",
  integrationMeta = {}
}) => {
  if (!restaurantId) {
    const error = new Error("Restaurant id is required");
    error.status = 400;
    throw error;
  }

  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) {
    const error = new Error("Order items are required");
    error.status = 400;
    throw error;
  }

  const restaurant = await Restaurant.findById(restaurantId).select("businessType").lean();
  const resolvedBusinessType =
    normalizeBusinessType(payload.businessType || restaurant?.businessType) || BUSINESS_TYPES.RESTAURANT;
  const isCloudKitchen = resolvedBusinessType === BUSINESS_TYPES.CLOUD_KITCHEN;

  const rawCustomerName = normalizeText(payload.customer?.name || payload.customerName);
  const customerPhone = normalizePhone(payload.customer?.phone || payload.customerPhone);
  const customerName = rawCustomerName || (isCloudKitchen ? "Guest" : rawCustomerName);
  const couponCode = normalizeCouponCode(payload.couponCode);
  const referralCode = normalizeReferralCode(payload.referralCode);
  const requestedServiceType = normalizeServiceType(payload.serviceType || payload.orderType);
  const serviceType =
    isCloudKitchen && requestedServiceType !== "TAKEAWAY" ? "DELIVERY" : requestedServiceType;
  const orderType = serviceType === "TAKEAWAY" ? "TAKEAWAY" : "DELIVERY";
  const tableCode = isCloudKitchen ? "" : String(payload.tableCode || "").trim().toUpperCase();
  const paymentMode = normalizePaymentMode(
    payload.paymentMethod || payload.paymentMode || payload.paymentType
  );
  const orderChannel = deriveOrderChannel({
    paymentMode,
    serviceType,
    orderChannel: requestedChannel || payload.orderChannel
  });
  const externalOrderId = normalizeText(payload.externalOrderId);

  if (externalOrderId) {
    const existingOrder = await Order.findOne({
      restaurantId,
      externalOrderId,
      orderChannel
    });

    if (existingOrder) {
      return { order: existingOrder, created: false };
    }
  }

  const menuItems = await MenuItem.find({ restaurantId });
  const cleanItems = buildCleanItems(items, menuItems);
  if (!cleanItems.length) {
    const error = new Error("Order items are invalid");
    error.status = 400;
    throw error;
  }

  if (isCloudKitchen) {
    await assertInventoryAvailableForItems({
      restaurantId,
      orderItems: cleanItems
    });
  }

  const subtotal = cleanItems.reduce((sum, item) => sum + item.quantity * item.price, 0);
  const calculatedTaxTotal = cleanItems.reduce(
    (sum, item) => sum + item.quantity * item.price * (item.gstPercentage / 100),
    0
  );
  const requestedTaxTotal = toNumber(payload.taxAmount ?? payload.gstTotal, Number.NaN);
  const gstTotal = Math.max(
    0,
    Number.isFinite(requestedTaxTotal) ? requestedTaxTotal : calculatedTaxTotal
  );
  const packagingCharge = Math.max(
    0,
    toNumber(payload.packagingCharge ?? payload.packaging)
  );

  let couponDiscount = 0;
  let coupon = null;
  if (couponCode) {
    coupon = await Coupon.findOne({
      restaurantId,
      code: couponCode,
      isActive: true,
      $or: [{ expiresAt: null }, { expiresAt: { $gte: new Date() } }]
    });

    if (!coupon) {
      const error = new Error("Coupon code is invalid or expired");
      error.status = 400;
      throw error;
    }
  }

  const manualDiscount = Math.max(0, toNumber(payload.discount));
  if (coupon) {
    if (subtotal < Number(coupon.minOrderValue || 0)) {
      const error = new Error(
        `Coupon requires a minimum order value of ${coupon.minOrderValue}`
      );
      error.status = 400;
      throw error;
    }

    couponDiscount =
      coupon.discountType === "FLAT"
        ? Number(coupon.discountValue || 0)
        : subtotal * (Number(coupon.discountValue || 0) / 100);
  }

  const safeDiscount = Math.max(0, manualDiscount + couponDiscount);
  const grossTotal = Math.max(0, subtotal + packagingCharge + gstTotal - safeDiscount);
  const commissionBasis = orderChannel === "DIRECT" || orderChannel === "WALK_IN"
    ? paymentMode
    : orderChannel;
  const commissionDeduction =
    grossTotal * toNumber(COMMISSION_RATE[commissionBasis], 0);
  const totalCost = cleanItems.reduce((sum, item) => sum + item.quantity * item.costPrice, 0);
  const netProfit = subtotal - totalCost - commissionDeduction;
  const loyaltyPointsEarned = customerPhone ? Math.max(1, Math.floor(grossTotal / 100)) : 0;
  const invoiceNumber = await buildInvoiceNumber(restaurantId);
  const expectedPrepTimeMinutes = getExpectedPrepTimeMinutesForItems(menuItems, cleanItems);
  const platform = normalizePlatform(payload.platform, orderChannel);

  const delivery = {
    partnerName: normalizeText(payload.delivery?.partnerName),
    partnerPhone: normalizePhone(payload.delivery?.partnerPhone),
    etaMinutes: Math.max(0, toNumber(payload.delivery?.etaMinutes)),
    notes: normalizeText(payload.delivery?.notes),
    assignedAt: payload.delivery?.assignedAt ? new Date(payload.delivery.assignedAt) : null,
    deliveredAt: payload.delivery?.deliveredAt ? new Date(payload.delivery.deliveredAt) : null
  };

  const initialStatus = isCloudKitchen ? "NEW" : "PREPARING";

  const order = new Order({
    restaurantId,
    invoiceNumber,
    items: cleanItems.map((item) => ({
      menuItemId: item.menuItemId,
      menuId: item.menuId,
      name: item.name,
      displayName: item.displayName,
      variant: item.variant,
      variantName: item.variantName,
      addons: item.addOns,
      addOns: item.addOns,
      notes: item.notes,
      image: item.image,
      quantity: item.quantity,
      price: item.price
    })),
    subtotal,
    gstTotal,
    packagingCharge,
    discount: safeDiscount,
    grandTotal: grossTotal,
    paymentMode,
    paymentType: paymentMode,
    commissionDeduction,
    netProfit,
    customerName,
    customerPhone,
    customer: {
      name: customerName,
      phone: customerPhone
    },
    couponCode,
    couponDiscount,
    loyaltyPointsEarned,
    referralCodeApplied: referralCode,
    businessType: resolvedBusinessType,
    serviceType,
    orderType,
    tableCode,
    platform,
    expectedPrepTimeMinutes,
    delivery,
    totalAmount: grossTotal,
    createdBy,
    status: initialStatus,
    statusTimeline: [
      {
        status: initialStatus,
        changedAt: new Date(),
        changedBy: createdBy || null
      }
    ],
    orderChannel,
    externalOrderId,
    integrationMeta: {
      source: orderChannel,
      sourceLabel: normalizeText(integrationMeta.sourceLabel || payload.sourceLabel),
      origin: normalizeText(integrationMeta.origin || payload.origin),
      websiteUrl: normalizeText(integrationMeta.websiteUrl || payload.websiteUrl),
      storeId: normalizeText(integrationMeta.storeId || payload.storeId),
      notes: normalizeText(integrationMeta.notes || payload.notes)
    }
  });

  let savedOrder = await order.save();
  if (isCloudKitchen) {
    await deductInventoryForItems({
      restaurantId,
      orderItems: cleanItems
    });
  } else {
    await applyInventoryDeductionForOrder(restaurantId, cleanItems);
  }

  savedOrder = await upsertCustomerForOrder({
    restaurantId,
    cleanItems,
    customerName,
    customerPhone,
    referralCode,
    grossTotal,
    loyaltyPointsEarned,
    invoiceNumber,
    savedOrder,
    serviceType,
    paymentMode,
    orderChannel
  });

  if (coupon) {
    coupon.usageCount = Number(coupon.usageCount || 0) + 1;
    await coupon.save();
  }

  return { order: savedOrder, created: true };
};

module.exports = {
  createOrderRecord,
  deriveOrderChannel,
  normalizeOrderChannel,
  serializeOrder
};
