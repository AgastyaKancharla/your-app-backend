const express = require("express");

const Customer = require("../models/Customer");
const Order = require("../models/Order");
const requirePermission = require("../middleware/requirePermission");
const createApiRateLimit = require("../middleware/apiRateLimit");
const { geocodeAddress, reverseGeocode } = require("../services/geocodingService");
const { parseLatitude, parseLongitude } = require("../utils/geoCoordinates");
const { getTenantRestaurantId, withTenantFilter, withTenantDocFilter } = require("../utils/tenantScope");

const router = express.Router();

const normalizePhone = (value = "") => String(value || "").replace(/[^\d+]/g, "").trim();
const normalizeText = (value = "") => String(value || "").trim();
const escapeRegex = (value = "") => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const lookupRateLimit = createApiRateLimit({
  keyPrefix: "customer_lookup",
  windowMs: 60 * 1000,
  maxAttempts: 120,
  message: "Too many customer lookup requests. Please retry shortly."
});
const geocodeRateLimit = createApiRateLimit({
  keyPrefix: "customer_geocode",
  windowMs: 60 * 1000,
  maxAttempts: 40,
  message: "Too many geocode requests. Please retry shortly."
});

const parseLocationFromRequest = (payload = {}) => {
  const latitude = parseLatitude(payload.latitude);
  const longitude = parseLongitude(payload.longitude);

  return {
    latitude,
    longitude,
    isValid: latitude.valid && longitude.valid
  };
};

const buildPhoneSearchFilter = (phoneInput = "") => {
  const normalizedPhone = normalizePhone(phoneInput);
  if (!normalizedPhone) {
    return null;
  }

  const digitsOnly = normalizedPhone.replace(/\D/g, "");
  const clauses = [{ phone: normalizedPhone }];

  if (digitsOnly && digitsOnly !== normalizedPhone) {
    clauses.push({ phone: digitsOnly });
  }

  if (digitsOnly.length >= 7) {
    clauses.push({
      phone: {
        $regex: new RegExp(`${escapeRegex(digitsOnly.slice(-10))}$`)
      }
    });
  }

  return clauses.length === 1 ? clauses[0] : { $or: clauses };
};

const buildOrderPhoneFilter = (phoneInput = "") => {
  const normalizedPhone = normalizePhone(phoneInput);
  if (!normalizedPhone) {
    return null;
  }

  const digitsOnly = normalizedPhone.replace(/\D/g, "");
  const clauses = [{ customerPhone: normalizedPhone }];

  if (digitsOnly && digitsOnly !== normalizedPhone) {
    clauses.push({ customerPhone: digitsOnly });
  }

  if (digitsOnly.length >= 7) {
    clauses.push({
      customerPhone: {
        $regex: new RegExp(`${escapeRegex(digitsOnly.slice(-10))}$`)
      }
    });
  }

  return clauses.length === 1 ? clauses[0] : { $or: clauses };
};

const buildFavoriteDishesFromOrders = (orders = []) => {
  const counts = new Map();

  orders.forEach((order) => {
    (order.items || []).forEach((item) => {
      const name = normalizeText(item?.displayName || item?.name);
      const quantity = Math.max(0, toNumber(item?.quantity));

      if (!name || quantity <= 0) {
        return;
      }

      counts.set(name, Number(counts.get(name) || 0) + quantity);
    });
  });

  return Array.from(counts.entries())
    .map(([name, orderCount]) => ({ name, orderCount }))
    .sort((a, b) => b.orderCount - a.orderCount)
    .slice(0, 8);
};

const buildOrderHistoryFromOrders = (orders = []) => {
  return orders
    .map((order) => {
      const totalAmount = Math.max(0, toNumber(order?.grandTotal ?? order?.totalAmount));
      const itemDetails = (order.items || [])
        .map((item) => {
          const quantity = Math.max(0, toNumber(item?.quantity));
          const unitPrice = Math.max(0, toNumber(item?.price));
          const name = normalizeText(item?.name);
          const displayName = normalizeText(item?.displayName || item?.name);

          if (!displayName || quantity <= 0) {
            return null;
          }

          return {
            name,
            displayName,
            quantity,
            unitPrice,
            lineTotal: Number((quantity * unitPrice).toFixed(2))
          };
        })
        .filter(Boolean);

      return {
        orderId: order._id || null,
        orderedAt: order.createdAt || null,
        totalAmount,
        invoiceNumber: normalizeText(order.invoiceNumber),
        orderStatus: normalizeText(order.status),
        serviceType: normalizeText(order.serviceType),
        paymentMode: normalizeText(order.paymentMode),
        items: itemDetails.map((item) =>
          item.quantity > 1 ? `${item.displayName} x${item.quantity}` : item.displayName
        ),
        itemDetails
      };
    })
    .sort((a, b) => new Date(b.orderedAt || 0).getTime() - new Date(a.orderedAt || 0).getTime())
    .slice(0, 100);
};

const backfillCustomersFromOrders = async (req, { phone = "", onlyWhenEmpty = false } = {}) => {
  const existingCount = await Customer.countDocuments(withTenantFilter(req));
  if (onlyWhenEmpty && existingCount > 0) {
    return { processed: 0, skipped: true };
  }

  const filter = withTenantFilter(req, {
    customerPhone: { $exists: true, $ne: "" }
  });

  const orderPhoneFilter = buildOrderPhoneFilter(phone);
  if (orderPhoneFilter) {
    Object.assign(filter, orderPhoneFilter);
  }

  const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(phone ? 1200 : 4000);
  if (!orders.length) {
    return { processed: 0, skipped: false };
  }

  const groupedByPhone = new Map();
  orders.forEach((order) => {
    const normalizedPhone = normalizePhone(order.customerPhone);
    if (!normalizedPhone) {
      return;
    }

    if (!groupedByPhone.has(normalizedPhone)) {
      groupedByPhone.set(normalizedPhone, []);
    }

    groupedByPhone.get(normalizedPhone).push(order);
  });

  if (!groupedByPhone.size) {
    return { processed: 0, skipped: false };
  }

  const restaurantId = getTenantRestaurantId(req);
  const operations = Array.from(groupedByPhone.entries()).map(([phoneNumber, customerOrders]) => {
    const sortedOrders = [...customerOrders].sort(
      (a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
    );

    const firstOrder = sortedOrders[0] || null;
    const lastOrder = sortedOrders[sortedOrders.length - 1] || null;
    const lifetimeValue = sortedOrders.reduce(
      (sum, order) => sum + Math.max(0, toNumber(order.grandTotal ?? order.totalAmount)),
      0
    );
    const firstKnownName = sortedOrders
      .map((order) => normalizeText(order.customerName))
      .find(Boolean);

    return {
      updateOne: {
        filter: withTenantFilter(req, { phone: phoneNumber }),
        update: {
          $setOnInsert: {
            restaurantId,
            phone: phoneNumber,
            source: "manual"
          },
          $set: {
            name: firstKnownName || "",
            orderCount: sortedOrders.length,
            totalOrders: sortedOrders.length,
            lifetimeValue: Number(lifetimeValue.toFixed(2)),
            totalSpent: Number(lifetimeValue.toFixed(2)),
            firstOrderAt: firstOrder?.createdAt || null,
            lastOrderAt: lastOrder?.createdAt || null,
            favoriteDishes: buildFavoriteDishesFromOrders(sortedOrders),
            orderHistory: buildOrderHistoryFromOrders(sortedOrders)
          }
        },
        upsert: true
      }
    };
  });

  if (!operations.length) {
    return { processed: 0, skipped: false };
  }

  await Customer.bulkWrite(operations, { ordered: false });
  return {
    processed: operations.length,
    skipped: false
  };
};

const computeCustomerMetrics = (customer) => {
  const orderCount = Math.max(0, toNumber(customer?.orderCount));
  const lifetimeValue = Math.max(0, toNumber(customer?.lifetimeValue));
  const averageOrderValue = orderCount ? lifetimeValue / orderCount : 0;

  return {
    averageOrderValue: Number(averageOrderValue.toFixed(2))
  };
};

const sanitizeCustomer = (customer) => ({
  id: customer._id,
  name: customer.name || "",
  phone: customer.phone || "",
  source: customer.source || "manual",
  email: customer.email || "",
  address: customer.address || "",
  city: customer.city || "",
  state: customer.state || "",
  pinCode: customer.pinCode || "",
  latitude:
    customer.latitude === null || customer.latitude === undefined
      ? null
      : Number(customer.latitude),
  longitude:
    customer.longitude === null || customer.longitude === undefined
      ? null
      : Number(customer.longitude),
  orderCount: Number(customer.orderCount || 0),
  totalOrders: Number(customer.totalOrders || customer.orderCount || 0),
  lifetimeValue: Number(customer.lifetimeValue || 0),
  totalSpent: Number(customer.totalSpent || customer.lifetimeValue || 0),
  loyaltyPoints: Number(customer.loyaltyPoints || 0),
  favoriteDishes: Array.isArray(customer.favoriteDishes) ? customer.favoriteDishes : [],
  orderHistory: Array.isArray(customer.orderHistory) ? customer.orderHistory : [],
  lastOrderAt: customer.lastOrderAt || null,
  firstOrderAt: customer.firstOrderAt || null,
  referralCode: customer.referralCode || "",
  referredByCode: customer.referredByCode || "",
  totalReferrals: Number(customer.totalReferrals || 0),
  marketingPreferences: {
    whatsapp: customer.marketingPreferences?.whatsapp !== false,
    sms: customer.marketingPreferences?.sms !== false
  },
  notes: customer.notes || "",
  metrics: computeCustomerMetrics(customer)
});

router.get("/", requirePermission("crm.view"), async (req, res) => {
  try {
    await backfillCustomersFromOrders(req, { onlyWhenEmpty: true });

    const searchQuery = normalizeText(req.query?.q);
    const phoneFilter = buildPhoneSearchFilter(req.query?.phone);
    const limit = Math.max(1, Math.min(500, Number(req.query?.limit) || 250));

    const filter = withTenantFilter(req);
    if (phoneFilter) {
      Object.assign(filter, phoneFilter);
    } else if (searchQuery) {
      const normalizedSearchPhone = normalizePhone(searchQuery);
      const searchPhoneFilter = buildPhoneSearchFilter(normalizedSearchPhone);
      const searchRegex = new RegExp(escapeRegex(searchQuery), "i");
      filter.$or = [{ name: { $regex: searchRegex } }];
      if (searchPhoneFilter) {
        if (searchPhoneFilter.$or) {
          filter.$or.push(...searchPhoneFilter.$or);
        } else {
          filter.$or.push(searchPhoneFilter);
        }
      } else {
        filter.$or.push({ phone: { $regex: searchRegex } });
      }
    }

    const customers = await Customer.find(filter)
      .sort({ lastOrderAt: -1, createdAt: -1 })
      .limit(limit);
    return res.json(customers.map(sanitizeCustomer));
  } catch (err) {
    return res.serverError(err);
  }
});

router.get(
  "/lookup",
  requirePermission("crm.view"),
  lookupRateLimit,
  async (req, res) => {
  try {
    const phoneFilter = buildPhoneSearchFilter(req.query.phone);
    if (!phoneFilter) {
      return res.status(400).json({ message: "Customer phone is required" });
    }

    let customer = await Customer.findOne(withTenantFilter(req, phoneFilter)).sort({
      lastOrderAt: -1,
      createdAt: -1
    });
    if (!customer) {
      await backfillCustomersFromOrders(req, { phone: req.query.phone });
      customer = await Customer.findOne(withTenantFilter(req, phoneFilter)).sort({
        lastOrderAt: -1,
        createdAt: -1
      });
    }

    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    return res.json(sanitizeCustomer(customer));
  } catch (err) {
    return res.serverError(err);
  }
});

router.get(
  "/geocode",
  requirePermission("crm.view"),
  geocodeRateLimit,
  async (req, res) => {
    try {
      const query = normalizeText(req.query?.query);
      if (!query || query.length < 3) {
        return res.status(400).json({ message: "A valid address query is required" });
      }

      const result = await geocodeAddress(query);
      if (!result) {
        return res.status(404).json({ message: "Unable to find location for this address" });
      }

      return res.json(result);
    } catch (err) {
      return res.serverError(err, {
        logLabel: "[customer-geocode]"
      });
    }
  }
);

router.get(
  "/reverse-geocode",
  requirePermission("crm.view"),
  geocodeRateLimit,
  async (req, res) => {
    try {
      const latitude = parseLatitude(req.query?.latitude ?? req.query?.lat);
      const longitude = parseLongitude(req.query?.longitude ?? req.query?.lng ?? req.query?.lon);
      if (!latitude.valid || !longitude.valid || latitude.value === null || longitude.value === null) {
        return res.status(400).json({ message: "Valid latitude and longitude are required" });
      }

      const result = await reverseGeocode({
        latitude: latitude.value,
        longitude: longitude.value
      });

      if (!result) {
        return res.status(404).json({ message: "Unable to resolve address for these coordinates" });
      }

      return res.json(result);
    } catch (err) {
      return res.serverError(err, {
        logLabel: "[customer-reverse-geocode]"
      });
    }
  }
);

router.post("/upsert", requirePermission("crm.create"), async (req, res) => {
  try {
    const restaurantId = getTenantRestaurantId(req);
    const phone = normalizePhone(req.body?.phone);
    if (!phone) {
      return res.status(400).json({ message: "Customer phone is required" });
    }

    const location = parseLocationFromRequest(req.body);
    if (!location.isValid) {
      return res.status(400).json({ message: "Invalid latitude or longitude values" });
    }

    const updates = {
      name: normalizeText(req.body?.name),
      email: normalizeText(req.body?.email).toLowerCase(),
      address: normalizeText(req.body?.address),
      city: normalizeText(req.body?.city),
      state: normalizeText(req.body?.state),
      pinCode: normalizeText(req.body?.pinCode),
      latitude: location.latitude.value,
      longitude: location.longitude.value,
      notes: normalizeText(req.body?.notes),
      marketingPreferences: {
        whatsapp: req.body?.whatsappOptIn === undefined ? true : Boolean(req.body.whatsappOptIn),
        sms: req.body?.smsOptIn === undefined ? true : Boolean(req.body.smsOptIn)
      }
    };

    if (req.body?.loyaltyPoints !== undefined) {
      updates.loyaltyPoints = Math.max(0, Number(req.body.loyaltyPoints || 0));
    }
    if (req.body?.referredByCode !== undefined) {
      updates.referredByCode = normalizeText(req.body.referredByCode).toUpperCase();
    }

    const customer = await Customer.findOneAndUpdate(
      withTenantFilter(req, { phone }),
      {
        $set: updates,
        $setOnInsert: {
          restaurantId,
          phone
        }
      },
      {
        upsert: true,
        new: true,
        runValidators: true
      }
    );

    return res.status(201).json(sanitizeCustomer(customer));
  } catch (err) {
    return res.serverError(err);
  }
});

router.put("/:id", requirePermission("crm.update"), async (req, res) => {
  try {
    const updates = {};
    const location = parseLocationFromRequest(req.body);
    if (
      (req.body?.latitude !== undefined || req.body?.longitude !== undefined) &&
      !location.isValid
    ) {
      return res.status(400).json({ message: "Invalid latitude or longitude values" });
    }

    if (req.body?.name !== undefined) {
      updates.name = normalizeText(req.body.name);
    }
    if (req.body?.email !== undefined) {
      updates.email = normalizeText(req.body.email).toLowerCase();
    }
    if (req.body?.address !== undefined) {
      updates.address = normalizeText(req.body.address);
    }
    if (req.body?.city !== undefined) {
      updates.city = normalizeText(req.body.city);
    }
    if (req.body?.state !== undefined) {
      updates.state = normalizeText(req.body.state);
    }
    if (req.body?.pinCode !== undefined) {
      updates.pinCode = normalizeText(req.body.pinCode);
    }
    if (req.body?.latitude !== undefined) {
      updates.latitude = location.latitude.value;
    }
    if (req.body?.longitude !== undefined) {
      updates.longitude = location.longitude.value;
    }
    if (req.body?.notes !== undefined) {
      updates.notes = normalizeText(req.body.notes);
    }
    if (req.body?.loyaltyPoints !== undefined) {
      updates.loyaltyPoints = Math.max(0, Number(req.body.loyaltyPoints || 0));
    }
    if (req.body?.whatsappOptIn !== undefined || req.body?.smsOptIn !== undefined) {
      updates.marketingPreferences = {
        whatsapp: req.body?.whatsappOptIn === undefined ? true : Boolean(req.body.whatsappOptIn),
        sms: req.body?.smsOptIn === undefined ? true : Boolean(req.body.smsOptIn)
      };
    }

    const customer = await Customer.findOneAndUpdate(
      withTenantDocFilter(req, req.params.id),
      updates,
      { new: true, runValidators: true }
    );

    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    return res.json(sanitizeCustomer(customer));
  } catch (err) {
    return res.serverError(err);
  }
});

module.exports = router;
