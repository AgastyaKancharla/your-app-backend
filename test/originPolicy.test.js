const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isLoopbackHostname,
  isDevelopmentLoopbackOrigin
} = require("../utils/originPolicy");

test("isLoopbackHostname accepts common local development hosts", () => {
  assert.equal(isLoopbackHostname("localhost"), true);
  assert.equal(isLoopbackHostname("127.0.0.1"), true);
  assert.equal(isLoopbackHostname("app.localhost"), true);
  assert.equal(isLoopbackHostname("::1"), true);
});

test("isDevelopmentLoopbackOrigin allows localhost origins outside production", () => {
  assert.equal(isDevelopmentLoopbackOrigin("http://localhost:3000"), true);
  assert.equal(isDevelopmentLoopbackOrigin("http://127.0.0.1:5173"), true);
  assert.equal(isDevelopmentLoopbackOrigin("https://admin.localhost:8443"), true);
});

test("isDevelopmentLoopbackOrigin rejects non-loopback or production origins", () => {
  assert.equal(isDevelopmentLoopbackOrigin("https://wevalue.in"), false);
  assert.equal(
    isDevelopmentLoopbackOrigin("http://localhost:3000", { isProduction: true }),
    false
  );
  assert.equal(isDevelopmentLoopbackOrigin("not-a-url"), false);
});
