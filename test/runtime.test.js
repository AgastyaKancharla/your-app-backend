const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { validateRuntimeConfig } = require("../config/runtime");

const ORIGINAL_ENV = { ...process.env };
const TEST_STORAGE_ROOT = path.join(__dirname, "runtime-storage");

const resetEnv = () => {
  Object.keys(process.env).forEach((key) => {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  });

  Object.assign(process.env, ORIGINAL_ENV);
};

test.afterEach(() => {
  resetEnv();
  fs.rmSync(TEST_STORAGE_ROOT, { recursive: true, force: true });
});

test("validateRuntimeConfig passes for a secure production configuration", () => {
  process.env.NODE_ENV = "production";
  process.env.JWT_SECRET = "12345678901234567890123456789012";
  process.env.SKIP_DB_CONNECT = "false";
  process.env.MONGO_URI =
    "mongodb+srv://user:password@cluster.mongodb.net/restaurantCRM?retryWrites=true&w=majority";
  process.env.APP_BASE_URL = "https://crm.example.com";
  process.env.CORS_ORIGIN = "https://crm.example.com";
  process.env.FILE_STORAGE_ROOT = "./test/runtime-storage";
  process.env.SERVE_FRONTEND = "false";
  process.env.REQUIRE_EMAIL_VERIFICATION = "true";
  process.env.RESEND_API_KEY = "re_test";
  process.env.RESEND_FROM_EMAIL = "CRM <no-reply@example.com>";
  process.env.LOGIN_OTP_ENABLED = "true";
  process.env.TWILIO_ACCOUNT_SID = "AC123";
  process.env.TWILIO_AUTH_TOKEN = "secret";
  process.env.TWILIO_FROM_PHONE = "+14155550100";

  const result = validateRuntimeConfig();

  assert.deepEqual(result.errors, []);
  assert.ok(result.storageRoot.endsWith(path.join("backend", "test", "runtime-storage")));
});

test("validateRuntimeConfig accepts APP_BASE_URL as the default production origin", () => {
  process.env.NODE_ENV = "production";
  process.env.JWT_SECRET = "12345678901234567890123456789012";
  process.env.SKIP_DB_CONNECT = "false";
  process.env.MONGO_URI =
    "mongodb+srv://user:password@cluster.mongodb.net/restaurantCRM?retryWrites=true&w=majority";
  process.env.APP_BASE_URL = "https://crm.example.com";
  process.env.FILE_STORAGE_ROOT = "./test/runtime-storage";
  process.env.SERVE_FRONTEND = "false";
  process.env.REQUIRE_EMAIL_VERIFICATION = "false";
  process.env.LOGIN_OTP_ENABLED = "false";

  const result = validateRuntimeConfig();

  assert.deepEqual(result.errors, []);
});

test("validateRuntimeConfig fails when production keeps insecure auth flags enabled", () => {
  process.env.NODE_ENV = "production";
  process.env.JWT_SECRET = "12345678901234567890123456789012";
  process.env.SKIP_DB_CONNECT = "false";
  process.env.MONGO_URI =
    "mongodb+srv://user:password@cluster.mongodb.net/restaurantCRM?retryWrites=true&w=majority";
  process.env.APP_BASE_URL = "https://crm.example.com";
  process.env.CORS_ORIGIN = "https://crm.example.com";
  process.env.FILE_STORAGE_ROOT = "./test/runtime-storage";
  process.env.SERVE_FRONTEND = "false";
  process.env.AUTH_INCLUDE_DEV_VERIFICATION_TOKEN = "true";
  process.env.LOGIN_OTP_INCLUDE_DEV_CODE = "true";
  process.env.AUTH_ALLOW_INSECURE_PASSWORD_RESET = "true";
  process.env.AUTH_ALLOW_QUICK_LOGIN = "true";

  const result = validateRuntimeConfig();

  assert.ok(
    result.errors.some((entry) =>
      entry.includes("AUTH_INCLUDE_DEV_VERIFICATION_TOKEN must be false in production")
    )
  );
  assert.ok(
    result.errors.some((entry) =>
      entry.includes("LOGIN_OTP_INCLUDE_DEV_CODE must be false in production")
    )
  );
  assert.ok(
    result.errors.some((entry) =>
      entry.includes("AUTH_ALLOW_INSECURE_PASSWORD_RESET must be false in production")
    )
  );
  assert.ok(
    result.errors.some((entry) => entry.includes("AUTH_ALLOW_QUICK_LOGIN must be false"))
  );
});

test("validateRuntimeConfig fails for cross-origin cookies without SameSite none", () => {
  process.env.NODE_ENV = "production";
  process.env.JWT_SECRET = "12345678901234567890123456789012";
  process.env.SKIP_DB_CONNECT = "false";
  process.env.MONGO_URI =
    "mongodb+srv://user:password@cluster.mongodb.net/restaurantCRM?retryWrites=true&w=majority";
  process.env.APP_BASE_URL = "https://api.example.com";
  process.env.CORS_ORIGIN = "https://crm.example.com";
  process.env.FILE_STORAGE_ROOT = "./test/runtime-storage";
  process.env.SERVE_FRONTEND = "false";
  process.env.AUTH_COOKIE_SECURE = "true";
  process.env.AUTH_COOKIE_SAME_SITE = "lax";
  process.env.REQUIRE_EMAIL_VERIFICATION = "false";
  process.env.LOGIN_OTP_ENABLED = "false";

  const result = validateRuntimeConfig();

  assert.ok(
    result.errors.some((entry) =>
      entry.includes("Cross-origin frontend deployments require AUTH_COOKIE_SAME_SITE=none")
    )
  );
});
