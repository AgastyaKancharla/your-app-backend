const { PLAN_LIMITS } = require("./planLimits");

const APP_CONFIG = {
  DEV_MODE_UNLOCK_ALL: true
};

const DEV_MODE_UNLOCKED_FEATURES = Object.freeze(
  Object.values(PLAN_LIMITS).reduce((accumulator, planDefinition) => {
    Object.keys(planDefinition?.features || {}).forEach((featureKey) => {
      accumulator[featureKey] = true;
    });

    return accumulator;
  }, {})
);

const DEV_MODE_UNLOCKED_LIMITS = Object.freeze(
  Object.values(PLAN_LIMITS).reduce((accumulator, planDefinition) => {
    Object.keys(planDefinition?.limits || {}).forEach((limitKey) => {
      accumulator[limitKey] = Infinity;
    });

    return accumulator;
  }, {})
);

if (APP_CONFIG.DEV_MODE_UNLOCK_ALL) {
  console.log("DEV MODE: Subscription bypass active");
}

const getDevModeUnlockedFeatures = () => ({ ...DEV_MODE_UNLOCKED_FEATURES });
const getDevModeUnlockedLimits = () => ({ ...DEV_MODE_UNLOCKED_LIMITS });

module.exports = {
  APP_CONFIG,
  getDevModeUnlockedFeatures,
  getDevModeUnlockedLimits
};
