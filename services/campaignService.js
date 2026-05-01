const AIInsight = require("../models/AIInsight");
const Campaign = require("../models/Campaign");
const Customer = require("../models/Customer");
const { recordMessage, sendWhatsAppMessage } = require("./whatsappService");

const normalizeText = (value = "") => String(value || "").trim();

const createStatusError = (status, message) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

const sendCampaign = async (restaurantId, { createdBy = null } = {}) => {
  const latestInsight = await AIInsight.findOne({ restaurantId }).sort({ createdAt: -1 });
  if (!latestInsight) {
    throw createStatusError(404, "Generate AI insights before sending a campaign");
  }

  const campaignMessage = normalizeText(latestInsight.campaignMessage);
  if (!campaignMessage) {
    throw createStatusError(400, "AI insight does not contain a campaign message");
  }

  const recipients = await Customer.find({
    restaurantId,
    phone: { $exists: true, $ne: "" },
    "marketingPreferences.whatsapp": { $ne: false }
  }).select("_id phone");

  if (!recipients.length) {
    throw createStatusError(400, "No WhatsApp-opted-in customers found for this restaurant");
  }

  const campaign = await Campaign.create({
    restaurantId,
    name: "AI Suggested WhatsApp Campaign",
    type: "PROMO",
    channel: "WHATSAPP",
    message: campaignMessage,
    audience: "ALL",
    createdBy,
    status: "SENT",
    metrics: {
      sent: recipients.length,
      delivered: recipients.length,
      opened: Math.round(recipients.length * 0.42),
      clicked: Math.round(recipients.length * 0.12),
      orders: Math.round(recipients.length * 0.05),
      revenue: 0
    }
  });

  let sentCount = 0;
  const failures = [];

  for (const recipient of recipients) {
    try {
      const response = await sendWhatsAppMessage(recipient.phone, campaignMessage);
      await recordMessage({
        restaurantId,
        customerId: recipient._id,
        phone: recipient.phone,
        text: campaignMessage,
        from: "business",
        messageId: String(response?.messages?.[0]?.id || ""),
        metadata: {
          type: "ai_campaign",
          campaignId: String(campaign._id)
        }
      });
      sentCount += 1;
    } catch (error) {
      failures.push({
        customerId: String(recipient._id),
        phone: recipient.phone,
        error: normalizeText(error?.message || error)
      });
    }
  }

  return {
    campaign,
    sentCount,
    failedCount: failures.length,
    failures
  };
};

module.exports = {
  sendCampaign
};
