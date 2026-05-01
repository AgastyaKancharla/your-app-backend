const mongoose = require("mongoose")

const ProcessedWebhookEvent = require("../models/ProcessedWebhookEvent")
const Restaurant = require("../models/Restaurant")
const { getOrCreateCustomer } = require("../services/customerService")
const {
  extractInboundMessages,
  getVerifyToken,
  handleAutoReply,
  normalizeText,
  recordMessage
} = require("../services/whatsappService")

const isDbConnected = () => mongoose.connection.readyState === 1

const createStatusError = (status, message) => {
  const error = new Error(message)
  error.status = status
  return error
}

const resolveRestaurantForWebhook = async (changeValue = {}) => {
  const explicitRestaurantId = normalizeText(process.env.WHATSAPP_RESTAURANT_ID)
  if (explicitRestaurantId && mongoose.Types.ObjectId.isValid(explicitRestaurantId)) {
    const restaurant = await Restaurant.findOne({
      _id: explicitRestaurantId,
      status: "ACTIVE"
    })

    if (restaurant) {
      return restaurant
    }
  }

  const incomingPhoneNumberId = normalizeText(
    changeValue?.metadata?.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID
  )

  if (incomingPhoneNumberId) {
    const configuredRestaurant = await Restaurant.findOne({
      status: "ACTIVE",
      "whatsapp.enabled": true,
      "whatsapp.phoneNumberId": incomingPhoneNumberId
    })

    if (configuredRestaurant) {
      return configuredRestaurant
    }

    const fallbackConfiguredRestaurant = await Restaurant.findOne({
      status: "ACTIVE",
      "whatsapp.phoneNumberId": incomingPhoneNumberId
    })

    if (fallbackConfiguredRestaurant) {
      return fallbackConfiguredRestaurant
    }
  }

  const activeRestaurants = await Restaurant.find({ status: "ACTIVE" })
    .sort({ createdAt: 1 })
    .limit(2)

  if (activeRestaurants.length === 1) {
    return activeRestaurants[0]
  }

  throw createStatusError(
    422,
    "Unable to resolve restaurant for WhatsApp webhook. Configure WHATSAPP_RESTAURANT_ID or assign whatsapp.phoneNumberId to the restaurant."
  )
}

const registerProcessedEvent = async (eventId) => {
  if (!eventId) {
    return true
  }

  try {
    await ProcessedWebhookEvent.create({
      provider: "WHATSAPP",
      eventId
    })
    return true
  } catch (error) {
    if (error?.code === 11000) {
      return false
    }

    throw error
  }
}

const unregisterProcessedEvent = async (eventId) => {
  if (!eventId) {
    return
  }

  try {
    await ProcessedWebhookEvent.deleteOne({
      provider: "WHATSAPP",
      eventId
    })
  } catch (error) {
    console.error("[whatsapp] failed to roll back processed event", error?.message || error)
  }
}

const verifyWebhook = (req, res) => {
  const verifyToken = getVerifyToken()
  const mode = normalizeText(req.query?.["hub.mode"] || req.query?.mode)
  const challenge = normalizeText(req.query?.["hub.challenge"] || req.query?.challenge)
  const token = normalizeText(req.query?.["hub.verify_token"] || req.query?.verify_token)

  if (mode === "subscribe" && token && verifyToken && token === verifyToken) {
    return res.status(200).send(challenge)
  }

  return res.sendStatus(403)
}

const handleWebhook = async (req, res) => {
  if (!isDbConnected()) {
    return res.status(503).json({
      message: "Database connection is not ready. Please retry in a moment."
    })
  }

  const inboundMessages = extractInboundMessages(req.body)

  if (!inboundMessages.length) {
    return res.status(200).json({
      received: true,
      processed: 0,
      skipped: 0,
      failed: 0
    })
  }

  let processed = 0
  let skipped = 0
  let failed = 0

  for (const inbound of inboundMessages) {
    const eventId = inbound.messageId || [inbound.entryId, inbound.eventKey].filter(Boolean).join(":")
    const isNewEvent = await registerProcessedEvent(eventId)

    if (!isNewEvent) {
      skipped += 1
      continue
    }

    try {
      const restaurant = await resolveRestaurantForWebhook(inbound.changeValue)
      const customer = await getOrCreateCustomer(inbound.phone, inbound.name, {
        restaurantId: restaurant._id,
        source: "whatsapp"
      })

      await recordMessage({
        restaurantId: restaurant._id,
        customerId: customer._id,
        phone: inbound.phone,
        text: inbound.text,
        from: "customer",
        messageId: inbound.messageId,
        metadata: {
          type: inbound.messageType
        }
      })

      await handleAutoReply({
        restaurant,
        customer,
        phone: inbound.phone,
        message: inbound.text,
        isText: inbound.isText
      })

      processed += 1
    } catch (error) {
      failed += 1
      await unregisterProcessedEvent(eventId)
      console.error("[whatsapp] failed to process inbound message", {
        eventId,
        phone: inbound.phone,
        error: error?.message || error
      })
    }
  }

  return res.status(200).json({
    received: true,
    processed,
    skipped,
    failed
  })
}

module.exports = {
  handleWebhook,
  verifyWebhook
}
