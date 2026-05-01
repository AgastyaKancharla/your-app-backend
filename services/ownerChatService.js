const AIInsight = require("../models/AIInsight");
const { buildAnalysisContext, callOpenAiChat } = require("./aiService");

const normalizeText = (value = "") => String(value || "").trim();

const handleOwnerQuery = async (restaurantId, question) => {
  const normalizedQuestion = normalizeText(question);
  if (!normalizedQuestion) {
    const error = new Error("Question is required");
    error.status = 400;
    throw error;
  }

  const [{ context }, latestInsight] = await Promise.all([
    buildAnalysisContext(restaurantId),
    AIInsight.findOne({ restaurantId }).sort({ createdAt: -1 })
  ]);

  const content = await callOpenAiChat({
    systemPrompt:
      "You are a restaurant growth advisor. Answer based on CRM data and give clear business advice. Be specific, concise, and practical for a restaurant owner.",
    userPrompt: JSON.stringify(
      {
        owner_question: normalizedQuestion,
        crm_context: context,
        latest_ai_insight: latestInsight
          ? {
              whatToSell: latestInsight.whatToSell,
              menuImprovements: latestInsight.menuImprovements,
              pricingStrategy: latestInsight.pricingStrategy,
              marketingIdeas: latestInsight.marketingIdeas,
              campaignMessage: latestInsight.campaignMessage,
              createdAt: latestInsight.createdAt
            }
          : null
      },
      null,
      2
    ),
    temperature: 0.4
  });

  return normalizeText(content);
};

module.exports = {
  handleOwnerQuery
};
