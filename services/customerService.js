const Customer = require("../models/Customer")

const normalizePhone = (value = "") => String(value || "").replace(/[^\d+]/g, "").trim()
const normalizeText = (value = "") => String(value || "").trim()

const buildGuestName = (phone = "") => {
  const digits = normalizePhone(phone).replace(/\D/g, "")
  const lastFourDigits = (digits.slice(-4) || "0000").padStart(4, "0")
  return "Customer_" + lastFourDigits
}

const isGeneratedGuestName = (value = "") => /^Customer_\d{4}$/.test(normalizeText(value))

const getOrCreateCustomer = async (phone, name, options = {}) => {
  const restaurantId = options.restaurantId || options.restaurant?._id || null
  if (!restaurantId) {
    const error = new Error("Restaurant id is required")
    error.status = 400
    throw error
  }

  const normalizedPhone = normalizePhone(phone)
  if (!normalizedPhone) {
    const error = new Error("Customer phone is required")
    error.status = 400
    throw error
  }

  const normalizedName = normalizeText(name)
  const fallbackName = buildGuestName(normalizedPhone)
  const source = normalizeText(options.source) || "whatsapp"

  let customer = await Customer.findOne({ restaurantId, phone: normalizedPhone })

  if (!customer) {
    customer = new Customer({
      restaurantId,
      phone: normalizedPhone,
      name: normalizedName || fallbackName,
      source
    })
    await customer.save()
    return customer
  }

  let shouldSave = false

  if ((!customer.name || isGeneratedGuestName(customer.name)) && normalizedName) {
    customer.name = normalizedName
    shouldSave = true
  } else if (!customer.name) {
    customer.name = fallbackName
    shouldSave = true
  }

  if (!customer.source) {
    customer.source = source
    shouldSave = true
  }

  if (shouldSave) {
    await customer.save()
  }

  return customer
}

module.exports = {
  getOrCreateCustomer,
  buildGuestName,
  normalizePhone
}
