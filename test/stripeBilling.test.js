const crypto = require("crypto");
const test = require("node:test");
const assert = require("node:assert/strict");

const { verifyStripeWebhookSignature } = require("../services/stripeBilling");

const ORIGINAL_ENV = { ...process.env };

const resetEnv = () => {
  Object.keys(process.env).forEach((key) => {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  });

  Object.assign(process.env, ORIGINAL_ENV);
};

const createSignatureHeader = ({ payload, secret, timestamp }) => {
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`, "utf8")
    .digest("hex");

  return `t=${timestamp},v1=${signature}`;
};

test.afterEach(() => {
  resetEnv();
});

test("verifyStripeWebhookSignature accepts a fresh signed payload", () => {
  const payload = JSON.stringify({ id: "evt_test", type: "invoice.paid" });
  const secret = "whsec_test";
  const timestamp = Math.floor(Date.now() / 1000);

  const verified = verifyStripeWebhookSignature({
    rawBody: Buffer.from(payload, "utf8"),
    signatureHeader: createSignatureHeader({ payload, secret, timestamp }),
    webhookSecret: secret
  });

  assert.equal(verified, true);
});

test("verifyStripeWebhookSignature rejects stale signed payloads", () => {
  const payload = JSON.stringify({ id: "evt_test", type: "invoice.paid" });
  const secret = "whsec_test";
  const timestamp = Math.floor(Date.now() / 1000) - 3600;

  const verified = verifyStripeWebhookSignature({
    rawBody: Buffer.from(payload, "utf8"),
    signatureHeader: createSignatureHeader({ payload, secret, timestamp }),
    webhookSecret: secret
  });

  assert.equal(verified, false);
});
