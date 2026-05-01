const fs = require("fs");
const http = require("http");
const path = require("path");
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const { Server } = require("socket.io");
require("dotenv").config({
  path: path.resolve(__dirname, ".env"),
  quiet: true
});
const { connectDB, getDbStatus } = require("./config/db");
const { assertRuntimeConfig, getRuntimeReadiness } = require("./config/runtime");

const orderRoutes = require("./routes/orderRoutes");
const crmRoutes = require("./routes/crmRoutes");
const deliveryRoutes = require("./routes/deliveryRoutes");
const tableRoutes = require("./routes/tableRoutes");
const reservationRoutes = require("./routes/reservationRoutes");
const supplierRoutes = require("./routes/supplierRoutes");
const purchaseOrderRoutes = require("./routes/purchaseOrderRoutes");
const inventoryRoutes = require("./routes/inventoryRoutes");
const recipeRoutes = require("./routes/recipeRoutes");
const reportRoutes = require("./routes/reportRoutes");
const financeRoutes = require("./routes/financeRoutes");
const dashboardRoutes = require("./routes/dashboardRoutes");
const insightRoutes = require("./routes/insightRoutes");
const alertRoutes = require("./routes/alertRoutes");
const activityRoutes = require("./routes/activityRoutes");
const menuRoutes = require("./routes/menuRoutes");
const documentRoutes = require("./routes/documentRoutes");
const expenseRoutes = require("./routes/expenseRoutes");
const staffRoutes = require("./routes/staffRoutes");
const aiRoutes = require("./routes/aiRoutes");
const trendRoutes = require("./routes/trendRoutes");
const externalOrderRoutes = require("./routes/externalOrderRoutes");
const adminRoutes = require("./routes/adminRoutes");
const billingRoutes = require("./routes/billingRoutes");
const billingWebhookRoutes = require("./routes/billingWebhookRoutes");
const webhookRoutes = require("./routes/webhookRoutes");
const authRoutes = require("./routes/authRoutes");
const onboardingAuthRoutes = require("./routes/onboardingAuthRoutes");
const profileRoutes = require("./routes/profileRoutes");
const restaurantRoutes = require("./routes/restaurantRoutes");
const subscriptionRoutes = require("./routes/subscriptionRoutes");
const authMiddleware = require("./middleware/authMiddleware");
const requireTenantContext = require("./middleware/requireTenantContext");
const requireHttps = require("./middleware/requireHttps");
const requestSanitizer = require("./middleware/requestSanitizer");
const securityHeaders = require("./middleware/securityHeaders");
const checkSubscription = require("./middleware/subscriptionMiddleware");
const { notFoundHandler, errorHandler, sendServerError } = require("./middleware/errorHandlers");
const { isDevelopmentLoopbackOrigin } = require("./utils/originPolicy");
const { getStorageRoot } = require("./utils/storagePaths");

const app = express();
const httpServer = http.createServer(app);
const isProduction = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const frontendBuildDir = path.resolve(
  __dirname,
  process.env.FRONTEND_BUILD_DIR || "../frontend/build"
);
const frontendIndexFile = path.join(frontendBuildDir, "index.html");
const frontendBuildAvailable = fs.existsSync(frontendIndexFile);
const shouldServeFrontend =
  frontendBuildAvailable &&
  String(process.env.SERVE_FRONTEND || "true").toLowerCase() !== "false";

const configuredOrigins = String(process.env.CORS_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const appOrigin = (() => {
  try {
    return process.env.APP_BASE_URL ? new URL(process.env.APP_BASE_URL).origin : "";
  } catch {
    return "";
  }
})();
const allowedOrigins = Array.from(new Set([...configuredOrigins, appOrigin].filter(Boolean)));
const ordersIo = new Server(httpServer, {
  cors: {
    origin: true,
    credentials: true
  }
}).of("/orders");

ordersIo.on("connection", (socket) => {
  const tenantId = String(
    socket.handshake.auth?.tenantId ||
      socket.handshake.query?.tenantId ||
      socket.handshake.headers?.["x-tenant-id"] ||
      ""
  ).trim();

  if (!tenantId || !mongoose.Types.ObjectId.isValid(tenantId)) {
    socket.emit("orders:error", { message: "A valid tenantId is required" });
    socket.disconnect(true);
    return;
  }

  socket.join(`tenant:${tenantId}`);
  socket.emit("orders:connected", {
    tenantId,
    namespace: "/orders",
    connectedAt: new Date().toISOString()
  });
});

const buildRuntimeOrigin = (req) => {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || req.protocol || "http")
    .split(",")[0]
    .trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || req.get("host") || "").trim();

  if (!forwardedHost) {
    return "";
  }

  return `${forwardedProto}://${forwardedHost}`;
};

const staticFileHeaders = (res, assetPath) => {
  if (assetPath.endsWith("index.html")) {
    res.setHeader("Cache-Control", "no-cache");
    return;
  }

  if (assetPath.includes(`${path.sep}static${path.sep}`)) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return;
  }

  res.setHeader("Cache-Control", "public, max-age=3600");
};

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.set("ordersIo", ordersIo);

app.use((req, res, next) => {
  res.serverError = (err, options = {}) => sendServerError(res, err, options);
  return next();
});

app.use(requireHttps);
app.use(securityHeaders);
app.use(
  cors((req, callback) => {
    const requestOrigin = String(req.header("Origin") || "").trim();
    const runtimeOrigin = buildRuntimeOrigin(req);
    const allowAllOrigins = !isProduction && !allowedOrigins.length;
    const allowRequest =
      !requestOrigin ||
      allowAllOrigins ||
      allowedOrigins.includes(requestOrigin) ||
      isDevelopmentLoopbackOrigin(requestOrigin, { isProduction }) ||
      (runtimeOrigin && requestOrigin === runtimeOrigin);

    if (!allowRequest) {
      const error = new Error("CORS blocked for this origin");
      error.status = 403;
      return callback(error);
    }

      return callback(null, {
        origin: true,
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: [
          "Content-Type",
          "Authorization",
          "X-Tenant-Id",
          "X-Super-Admin-Key",
          "X-CRM-Integration-Key"
        ],
        credentials: true
      });
    })
);
app.use(
  "/api/billing/webhook/stripe",
  express.raw({ type: "application/json" }),
  billingWebhookRoutes
);
app.use(express.json({ limit: "2mb" }));
app.use("/webhook", webhookRoutes);
app.use(requestSanitizer);
app.use(
  "/storage",
  express.static(getStorageRoot(), {
    fallthrough: false,
    maxAge: "7d"
  })
);

app.use("/api/auth", onboardingAuthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/integrations/orders", externalOrderRoutes);
app.use("/api/restaurant", authMiddleware, restaurantRoutes);
app.use("/api/subscription", authMiddleware, requireTenantContext, subscriptionRoutes);
app.use("/api/profile", authMiddleware, requireTenantContext, checkSubscription, profileRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/billing", authMiddleware, requireTenantContext, billingRoutes);
app.use("/api/orders", authMiddleware, requireTenantContext, checkSubscription, orderRoutes);
app.use("/api/crm", authMiddleware, requireTenantContext, checkSubscription, crmRoutes);
app.use("/api/delivery", authMiddleware, requireTenantContext, checkSubscription, deliveryRoutes);
app.use("/api/tables", authMiddleware, requireTenantContext, checkSubscription, tableRoutes);
app.use(
  "/api/reservations",
  authMiddleware,
  requireTenantContext,
  checkSubscription,
  reservationRoutes
);
app.use("/api/suppliers", authMiddleware, requireTenantContext, checkSubscription, supplierRoutes);
app.use(
  "/api/purchase-orders",
  authMiddleware,
  requireTenantContext,
  checkSubscription,
  purchaseOrderRoutes
);
app.use("/api/inventory", authMiddleware, requireTenantContext, checkSubscription, inventoryRoutes);
app.use("/api/recipes", authMiddleware, requireTenantContext, checkSubscription, recipeRoutes);
app.use("/api/reports", authMiddleware, requireTenantContext, checkSubscription, reportRoutes);
app.use("/api/finance", authMiddleware, requireTenantContext, checkSubscription, financeRoutes);
app.use("/api/dashboard", authMiddleware, requireTenantContext, checkSubscription, dashboardRoutes);
app.use("/api/insights", authMiddleware, requireTenantContext, checkSubscription, insightRoutes);
app.use("/api/alerts", authMiddleware, requireTenantContext, checkSubscription, alertRoutes);
app.use("/api/activity", authMiddleware, requireTenantContext, checkSubscription, activityRoutes);
app.use("/api/menu", authMiddleware, requireTenantContext, checkSubscription, menuRoutes);
app.use("/api/documents", authMiddleware, requireTenantContext, checkSubscription, documentRoutes);
app.use("/api/expenses", authMiddleware, requireTenantContext, checkSubscription, expenseRoutes);
app.use("/api/staff", authMiddleware, requireTenantContext, checkSubscription, staffRoutes);
app.use("/api/ai", authMiddleware, requireTenantContext, checkSubscription, aiRoutes);
app.use("/api/trends", authMiddleware, requireTenantContext, checkSubscription, trendRoutes);

app.get("/health", (_req, res) => {
  return res.json({
    status: "ok",
    service: "wevalue-backend",
    timestamp: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime())
  });
});

app.get("/ready", (_req, res) => {
  const dbReady = mongoose.connection.readyState === 1;
  const dbStatus = getDbStatus();
  const runtime = getRuntimeReadiness();
  const allowFallbackReadiness =
    !isProduction && !dbReady && Boolean(dbStatus.fallbackMode);

  if (!dbReady && !allowFallbackReadiness) {
    return res.status(503).json({
      status: "not_ready",
      dbReady,
      fallbackMode: Boolean(dbStatus.fallbackMode),
      dbError: dbStatus.lastError || "",
      runtime
    });
  }

  return res.json({
    status: allowFallbackReadiness ? "ready_fallback" : "ready",
    dbReady,
    fallbackMode: Boolean(dbStatus.fallbackMode),
    dbError: dbStatus.lastError || "",
    runtime
  });
});

if (shouldServeFrontend) {
  app.use(
    express.static(frontendBuildDir, {
      index: false,
      setHeaders: staticFileHeaders
    })
  );

  app.get("/", (_req, res) => {
    return res.sendFile(frontendIndexFile);
  });

  app.use((req, res, next) => {
    if (req.method !== "GET") {
      return next();
    }

    if (
      req.path === "/api" ||
      req.path.startsWith("/api/") ||
      req.path === "/health" ||
      req.path === "/ready"
    ) {
      return next();
    }

    if (path.extname(req.path)) {
      return next();
    }

    const acceptHeader = String(req.headers.accept || "");
    if (!acceptHeader.includes("text/html") && !acceptHeader.includes("*/*")) {
      return next();
    }

    return res.sendFile(frontendIndexFile);
  });
} else {
  app.get("/", (_req, res) => {
    res.send("WeValue Backend is Running");
  });
}

app.use(notFoundHandler);
app.use(errorHandler);

const PORT = Number(process.env.PORT || 5000);
const startServer = async () => {
  assertRuntimeConfig();
  await connectDB();

  if (shouldServeFrontend) {
    console.log(`Serving frontend build from ${frontendBuildDir}`);
  } else if (
    String(process.env.SERVE_FRONTEND || "true").toLowerCase() !== "false" &&
    !frontendBuildAvailable
  ) {
    console.warn(`Frontend build not found at ${frontendBuildDir}. Run the frontend build before deployment.`);
  }

  httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
};

startServer().catch((error) => {
  console.error("Unable to start backend server:", error?.message || error);
  process.exit(1);
});
