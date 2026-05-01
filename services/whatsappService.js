const MenuItem = require("../models/MenuItem")
const Message = require("../models/Message")
const { normalizePhone } = require("./customerService")
const { createOrderFromParsedMessage, parseOrderMessage } = require("./orderService")

const MAX_WHATSAPP_TEXT_LENGTH = 4096

const normalizeText = (value = "") => String(value || "").trim()
const escapeRegex = (value = "") => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const containsWord = (input = "", word = "") => {
  const safeInput = String(input || "")
  const safeWord = normalizeText(word)
  if (!safeInput || !safeWord) {
    return false
  }

  return new RegExp("\\b" + escapeRegex(safeWord) + "\\b", "i").test(safeInput)
}

const trimWhatsAppText = (value = "") => {
  const normalized = normalizeText(value)
  if (normalized.length <= MAX_WHATSAPP_TEXT_LENGTH) {
    return normalized
  }

  return normalized.slice(0, MAX_WHATSAPP_TEXT_LENGTH - 3) + "..."
}

const getVerifyToken = () =>
  normalizeText(process.env.WHATSAPP_VERIFY_TOKEN || process.env.VERIFY_TOKEN)

const getWhatsAppConfig = () => ({
  token: normalizeText(process.env.WHATSAPP_TOKEN),
  phoneNumberId: normalizeText(process.env.WHATSAPP_PHONE_NUMBER_ID),
  verifyToken: getVerifyToken()
})

const ensureOutboundConfig = () => {
  const config = getWhatsAppConfig()
  if (!config.token || !config.phoneNumberId) {
    const error = new Error(
      "WhatsApp Cloud API is not configured. Set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID."
    )
    error.status = 500
    throw error
  }

  return config
}

const extractIncomingMessageText = (message = {}) => {
  if (message?.text?.body) {
    return normalizeText(message.text.body)
  }

  if (message?.button?.text) {
    return normalizeText(message.button.text)
  }

  if (message?.interactive?.button_reply?.title) {
    return normalizeText(message.interactive.button_reply.title)
  }

  if (message?.interactive?.list_reply?.title) {
    return normalizeText(message.interactive.list_reply.title)
  }

  if (message?.type) {
    return "[" + normalizeText(message.type).toLowerCase() + "]"
  }

  return ""
}

const isTextLikeMessage = (message = {}) => {
  return Boolean(
    message?.text?.body ||
      message?.button?.text ||
      message?.interactive?.button_reply?.title ||
      message?.interactive?.list_reply?.title
  )
}

const extractInboundMessages = (payload = {}) => {
  const entries = Array.isArray(payload.entry) ? payload.entry : []
  const extractedMessages = []

  entries.forEach((entry, entryIndex) => {
    const changes = Array.isArray(entry?.changes) ? entry.changes : []

    changes.forEach((change, changeIndex) => {
      const value = change?.value || {}
      const contacts = Array.isArray(value.contacts) ? value.contacts : []
      const contactsByPhone = new Map(
        contacts
          .map((contact) => [normalizePhone(contact?.wa_id), contact])
          .filter(([phone]) => phone)
      )
      const messages = Array.isArray(value.messages) ? value.messages : []

      messages.forEach((message, messageIndex) => {
        const phone = normalizePhone(message?.from)
        if (!phone) {
          return
        }

        const contact = contactsByPhone.get(phone)
        const text = extractIncomingMessageText(message)
        const name = normalizeText(message?.profile?.name || contact?.profile?.name)

        extractedMessages.push({
          entryId: normalizeText(entry?.id),
          phone,
          name,
          text,
          isText: isTextLikeMessage(message),
          messageId: normalizeText(message?.id),
          messageType: normalizeText(message?.type || (text ? "text" : "")),
          changeValue: value,
          eventKey: [entryIndex, changeIndex, messageIndex, phone, text].join(":"),
          rawMessage: message
        })
      })
    })
  })

  return extractedMessages
}

const recordMessage = async ({
  restaurantId,
  customerId = null,
  phone,
  text,
  from,
  messageId = "",
  metadata = null
}) => {
  if (!restaurantId || !normalizePhone(phone) || !normalizeText(from)) {
    return null
  }

  return Message.create({
    restaurantId,
    customerId,
    phone: normalizePhone(phone),
    text: trimWhatsAppText(text),
    from: normalizeText(from).toLowerCase(),
    messageId: normalizeText(messageId),
    metadata
  })
}

const parseResponseBody = async (response) => {
  const rawBody = await response.text()
  if (!rawBody) {
    return {}
  }

  try {
    return JSON.parse(rawBody)
  } catch {
    return { raw: rawBody }
  }
}

const sendWhatsAppMessage = async (to, text) => {
  const config = ensureOutboundConfig()

  if (typeof fetch !== "function") {
    throw new Error("Global fetch is not available in this Node runtime")
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)

  try {
    const response = await fetch(
      "https://graph.facebook.com/v18.0/" + config.phoneNumberId + "/messages",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + config.token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: normalizePhone(to),
          text: {
            body: trimWhatsAppText(text)
          }
        }),
        signal: controller.signal
      }
    )

    const data = await parseResponseBody(response)

    if (!response.ok) {
      const error = new Error(
        normalizeText(data?.error?.message || data?.raw || "WhatsApp Cloud API request failed")
      )
      error.status = response.status
      error.details = data
      throw error
    }

    return data
  } finally {
    clearTimeout(timeout)
  }
}

const sendAndStoreWhatsAppMessage = async ({ restaurantId, customerId, to, text, metadata = null }) => {
  const response = await sendWhatsAppMessage(to, text)
  const outgoingMessageId = normalizeText(response?.messages?.[0]?.id)

  await recordMessage({
    restaurantId,
    customerId,
    phone: to,
    text,
    from: "business",
    messageId: outgoingMessageId,
    metadata
  })

  return response
}

const buildRestaurantName = (restaurant = {}) => {
  return normalizeText(restaurant?.restaurantName || restaurant?.name) || "Louisa's Kitchen"
}

const buildWelcomeMessage = (restaurant = {}) => {
  return trimWhatsAppText(
    "👋 Welcome to " + buildRestaurantName(restaurant) + "!\nType MENU to see today's menu."
  )
}

const formatCurrency = (value) => {
  const amount = Number(value || 0)
  if (!Number.isFinite(amount)) {
    return "0"
  }

  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2)
}

const buildMenuMessage = async ({ restaurantId }) => {
  const menuItems = await MenuItem.find({
    restaurantId,
    isAvailable: true
  })
    .sort({ category: 1, name: 1 })
    .limit(10)
    .select("name sellingPrice price")

  if (!menuItems.length) {
    return trimWhatsAppText(
      "🍽 Today's Menu:\n1. Chicken Biryani - ₹150\n2. Veg Meals - ₹120\nReply ORDER to place order."
    )
  }

  const lines = menuItems.map((item, index) => {
    const price = Number(item?.sellingPrice ?? item?.price ?? 0)
    return String(index + 1) + ". " + item.name + " - ₹" + formatCurrency(price)
  })

  return trimWhatsAppText(
    "🍽 Today's Menu:\n" + lines.join("\n") + "\nReply ORDER to place order."
  )
}

const buildOrderGuideMessage = () => {
  return trimWhatsAppText(
    "🛒 Please type:\nITEM NAME + QUANTITY\nExample: Biryani 2"
  )
}

const buildUnknownMessage = () => {
  return trimWhatsAppText("Sorry, I didn’t understand.\nType MENU or ORDER.")
}

const buildItemNotFoundMessage = () => {
  return trimWhatsAppText("Sorry, I couldn't match that item. Type MENU to see available items.")
}

const handleAutoReply = async ({ restaurant, customer, phone, message, isText = true }) => {
  if (!restaurant?._id || !customer?._id || !normalizePhone(phone)) {
    const error = new Error("Restaurant, customer, and phone are required for WhatsApp auto reply")
    error.status = 400
    throw error
  }

  const normalizedMessage = normalizeText(message)
  if (!isText || !normalizedMessage) {
    return {
      handled: false,
      reason: "NON_TEXT_OR_EMPTY"
    }
  }

  const lowerMessage = normalizedMessage.toLowerCase()
  let replyText = ""
  let createdOrder = null

  if (containsWord(lowerMessage, "hi") || containsWord(lowerMessage, "hello")) {
    replyText = buildWelcomeMessage(restaurant)
  } else if (containsWord(lowerMessage, "menu")) {
    replyText = await buildMenuMessage({ restaurantId: restaurant._id })
  } else if (/^order$/i.test(normalizedMessage)) {
    replyText = buildOrderGuideMessage()
  } else {
    const parsedOrder = parseOrderMessage(normalizedMessage)

    if (parsedOrder) {
      const orderResult = await createOrderFromParsedMessage({
        restaurant,
        customer,
        parsedOrder
      })

      if (orderResult?.order) {
        createdOrder = orderResult.order
        replyText = trimWhatsAppText(
          "✅ Order received: " + parsedOrder.quantity + " " + orderResult.menuItem.name
        )
      } else {
        replyText = buildItemNotFoundMessage()
      }
    } else if (containsWord(lowerMessage, "order")) {
      replyText = buildOrderGuideMessage()
    } else {
      replyText = buildUnknownMessage()
    }
  }

  const response = await sendAndStoreWhatsAppMessage({
    restaurantId: restaurant._id,
    customerId: customer._id,
    to: phone,
    text: replyText,
    metadata: {
      reason: createdOrder ? "order_confirmation" : "auto_reply"
    }
  })

  return {
    handled: true,
    replyText,
    createdOrder,
    response
  }
}

module.exports = {
  buildMenuMessage,
  extractInboundMessages,
  extractIncomingMessageText,
  getVerifyToken,
  handleAutoReply,
  normalizeText,
  recordMessage,
  sendWhatsAppMessage
}
