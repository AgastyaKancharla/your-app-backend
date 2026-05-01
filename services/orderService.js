const MenuItem = require("../models/MenuItem")
const { createOrderRecord } = require("./orderCreationService")

const normalizeText = (value = "") => String(value || "").trim()
const escapeRegex = (value = "") => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const RESERVED_COMMANDS = new Set(["hi", "hello", "menu", "order"])

const parseOrderMessage = (input = "") => {
  const compactMessage = normalizeText(input).replace(/\s+/g, " ")
  if (!compactMessage || !/\d/.test(compactMessage)) {
    return null
  }

  const sanitizedMessage = compactMessage.replace(/^order\s+/i, "")
  const trailingMatch = sanitizedMessage.match(/^(.+?)\s*[xX]?\s*(\d{1,3})$/)
  const leadingMatch = trailingMatch ? null : sanitizedMessage.match(/^(\d{1,3})\s+(.+)$/)

  if (!trailingMatch && !leadingMatch) {
    return null
  }

  const rawItemName = normalizeText(
    trailingMatch ? trailingMatch[1] : leadingMatch ? leadingMatch[2] : ""
  ).replace(/[.,]+$/g, "")
  const quantity = Number(trailingMatch ? trailingMatch[2] : leadingMatch ? leadingMatch[1] : 0)

  if (!rawItemName || !Number.isFinite(quantity) || quantity <= 0 || quantity > 50) {
    return null
  }

  if (RESERVED_COMMANDS.has(rawItemName.toLowerCase())) {
    return null
  }

  return {
    itemName: rawItemName,
    quantity
  }
}

const findMenuItemMatch = async ({ restaurantId, itemName }) => {
  const exactFilter = {
    restaurantId,
    isAvailable: true,
    name: { $regex: new RegExp("^" + escapeRegex(itemName) + "$", "i") }
  }
  const prefixFilter = {
    restaurantId,
    isAvailable: true,
    name: { $regex: new RegExp("^" + escapeRegex(itemName), "i") }
  }
  const containsFilter = {
    restaurantId,
    isAvailable: true,
    name: { $regex: new RegExp(escapeRegex(itemName), "i") }
  }

  return (
    (await MenuItem.findOne(exactFilter)) ||
    (await MenuItem.findOne(prefixFilter).sort({ name: 1 })) ||
    (await MenuItem.findOne(containsFilter).sort({ name: 1 }))
  )
}

const createOrderFromParsedMessage = async ({ restaurant, customer, parsedOrder }) => {
  if (!restaurant?._id) {
    const error = new Error("Restaurant is required for WhatsApp order creation")
    error.status = 400
    throw error
  }

  if (!customer?.phone) {
    const error = new Error("Customer is required for WhatsApp order creation")
    error.status = 400
    throw error
  }

  if (!parsedOrder?.itemName || !parsedOrder?.quantity) {
    return {
      created: false,
      order: null,
      menuItem: null
    }
  }

  const menuItem = await findMenuItemMatch({
    restaurantId: restaurant._id,
    itemName: parsedOrder.itemName
  })

  if (!menuItem) {
    return {
      created: false,
      order: null,
      menuItem: null
    }
  }

  const result = await createOrderRecord({
    restaurantId: restaurant._id,
    payload: {
      items: [
        {
          name: menuItem.name,
          quantity: parsedOrder.quantity
        }
      ],
      customerName: customer.name,
      customerPhone: customer.phone,
      serviceType: "DELIVERY",
      paymentMode: "CASH"
    },
    requestedChannel: "DIRECT",
    integrationMeta: {
      sourceLabel: "WhatsApp",
      origin: "whatsapp-cloud-api",
      notes: "Auto-created from inbound WhatsApp message"
    }
  })

  return {
    created: result.created,
    order: result.order,
    menuItem
  }
}

module.exports = {
  createOrderFromParsedMessage,
  findMenuItemMatch,
  parseOrderMessage
}
