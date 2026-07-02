require("dotenv").config();
const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/authRoutes");
const restaurantRoutes = require("./routes/restaurantRoutes");
const menuRoutes = require("./routes/menuRoutes");
const orderRoutes = require("./routes/orderRoutes");
const inventoryRoutes = require("./routes/inventoryRoutes");
const recipeRoutes = require("./routes/recipeRoutes");

const app = express();

// ----------------------------------------------------------------------------
// CORS — explicit allowlist, credentials enabled. No wildcard in production.
// ----------------------------------------------------------------------------
const allowedOrigins = String(process.env.CORS_ORIGIN || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow no-origin requests (server-to-server, curl, health checks)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true
  })
);

app.use(express.json({ limit: "2mb" }));

// ----------------------------------------------------------------------------
// Health check — no auth required, used by Vercel/uptime monitors
// ----------------------------------------------------------------------------
app.get("/ready", (req, res) => {
  res.json({
    status: "ready",
    supabaseConfigured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY),
    timestamp: new Date().toISOString()
  });
});

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
app.use("/api/auth", authRoutes);
app.use("/api/restaurants", restaurantRoutes);
app.use("/api/menu-items", menuRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/ingredients", inventoryRoutes);
app.use("/api/recipes", recipeRoutes);

// ----------------------------------------------------------------------------
// 404 + error handling
// ----------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ message: "Not found" });
});

app.use((err, req, res, next) => {
  if (err.message?.includes("not allowed by CORS")) {
    return res.status(403).json({ message: "Origin not allowed" });
  }
  console.error("[unhandled error]", err);
  return res.status(500).json({ message: "Internal server error" });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`WeValue backend listening on port ${PORT}`);
  });
}

module.exports = app;
