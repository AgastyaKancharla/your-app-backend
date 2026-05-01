const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getCookieSettings,
  parseRequestCookies,
  getAuthCookiesFromRequest,
  setAuthCookies,
  clearAuthCookies
} = require("../utils/httpCookies");

const ORIGINAL_ENV = { ...process.env };

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
});

test("parseRequestCookies reads simple cookie headers", () => {
  const cookies = parseRequestCookies({
    headers: {
      cookie: "alpha=one; beta=two%20words"
    }
  });

  assert.deepEqual(cookies, {
    alpha: "one",
    beta: "two words"
  });
});

test("getAuthCookiesFromRequest uses configured cookie names", () => {
  process.env.AUTH_ACCESS_COOKIE_NAME = "crm_access";
  process.env.AUTH_REFRESH_COOKIE_NAME = "crm_refresh";

  const cookies = getAuthCookiesFromRequest({
    headers: {
      cookie: "crm_access=access-token; crm_refresh=refresh-token"
    }
  });

  assert.equal(cookies.accessToken, "access-token");
  assert.equal(cookies.refreshToken, "refresh-token");
});

test("setAuthCookies and clearAuthCookies apply secure cookie options", () => {
  process.env.NODE_ENV = "production";
  process.env.AUTH_ACCESS_COOKIE_NAME = "crm_access";
  process.env.AUTH_REFRESH_COOKIE_NAME = "crm_refresh";
  process.env.AUTH_COOKIE_SECURE = "true";
  process.env.AUTH_COOKIE_SAME_SITE = "lax";

  const captured = {
    set: [],
    clear: []
  };
  const res = {
    cookie(name, value, options) {
      captured.set.push({ name, value, options });
    },
    clearCookie(name, options) {
      captured.clear.push({ name, options });
    }
  };

  setAuthCookies(res, {
    accessToken: "access-token",
    refreshToken: "refresh-token"
  });
  clearAuthCookies(res);

  assert.equal(captured.set.length, 2);
  assert.equal(captured.clear.length, 2);
  assert.equal(captured.set[0].name, "crm_access");
  assert.equal(captured.set[1].name, "crm_refresh");
  assert.equal(captured.set[0].options.httpOnly, true);
  assert.equal(captured.set[0].options.secure, true);
  assert.equal(captured.set[0].options.sameSite, "lax");
});

test("getCookieSettings defaults secure cookies to SameSite none", () => {
  process.env.NODE_ENV = "production";
  process.env.AUTH_COOKIE_SECURE = "true";
  delete process.env.AUTH_COOKIE_SAME_SITE;

  const settings = getCookieSettings();

  assert.equal(settings.secure, true);
  assert.equal(settings.sameSite, "none");
});
