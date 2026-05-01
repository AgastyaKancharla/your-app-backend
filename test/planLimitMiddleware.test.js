const test = require("node:test");
const assert = require("node:assert/strict");

const {
  requirePlanFeature,
  requireReportRangeWithinPlan
} = require("../middleware/planLimitMiddleware");

const createResMock = () => {
  const response = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };

  return response;
};

test("requirePlanFeature allows access when feature exists on current plan", () => {
  const middleware = requirePlanFeature("customerCRM", {
    requiredPlan: "GROWTH"
  });

  const req = {
    restaurant: { subscriptionPlan: "GROWTH" }
  };
  const res = createResMock();

  let nextCalled = false;
  middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, null);
});

test("requirePlanFeature blocks access when feature is not available", () => {
  const middleware = requirePlanFeature("deliveryManagement", {
    requiredPlan: "PRO",
    message: "Delivery management is available on PRO and above plans."
  });

  const req = {
    restaurant: { subscriptionPlan: "STARTER" }
  };
  const res = createResMock();

  let nextCalled = false;
  middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.upgradeRequired, true);
  assert.equal(res.body.feature, "deliveryManagement");
  assert.equal(res.body.requiredPlan, "PRO");
  assert.equal(res.body.plan, "STARTER");
});

test("requireReportRangeWithinPlan blocks ranges above current plan limit", () => {
  const req = {
    restaurant: { subscriptionPlan: "STARTER" },
    query: {
      days: "45"
    }
  };
  const res = createResMock();

  let nextCalled = false;
  requireReportRangeWithinPlan(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.feature, "reportRangeDays");
  assert.equal(res.body.limit, 30);
  assert.equal(res.body.current, 45);
});
