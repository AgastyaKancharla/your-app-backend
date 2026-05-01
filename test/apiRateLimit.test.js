const test = require("node:test");
const assert = require("node:assert/strict");

const createApiRateLimit = require("../middleware/apiRateLimit");

const createReq = (path = "/lookup") => ({
  headers: {},
  socket: { remoteAddress: "127.0.0.1" },
  baseUrl: "/api/customers",
  route: { path },
  path
});

const createRes = () => {
  const response = {
    headers: {},
    statusCode: 200,
    body: null
  };

  return {
    set(name, value) {
      response.headers[name] = value;
    },
    status(code) {
      response.statusCode = code;
      return this;
    },
    json(payload) {
      response.body = payload;
      return this;
    },
    _response: response
  };
};

test("apiRateLimit allows requests below threshold", async () => {
  const limiter = createApiRateLimit({
    keyPrefix: "test-limit",
    windowMs: 30_000,
    maxAttempts: 3
  });

  let nextCalls = 0;

  for (let index = 0; index < 3; index += 1) {
    const req = createReq();
    const res = createRes();
    await limiter(req, res, () => {
      nextCalls += 1;
    });
    assert.equal(res._response.statusCode, 200);
  }

  assert.equal(nextCalls, 3);
});

test("apiRateLimit blocks when threshold is exceeded", async () => {
  const limiter = createApiRateLimit({
    keyPrefix: "test-limit-block",
    windowMs: 30_000,
    maxAttempts: 2,
    message: "Too many requests for testing."
  });

  for (let index = 0; index < 2; index += 1) {
    const req = createReq();
    const res = createRes();
    await limiter(req, res, () => {});
    assert.equal(res._response.statusCode, 200);
  }

  const blockedReq = createReq();
  const blockedRes = createRes();
  await limiter(blockedReq, blockedRes, () => {});

  assert.equal(blockedRes._response.statusCode, 429);
  assert.equal(
    blockedRes._response.body.message,
    "Too many requests for testing."
  );
  assert.ok(blockedRes._response.headers["Retry-After"]);
});
