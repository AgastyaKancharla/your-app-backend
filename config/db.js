const mongoose = require("mongoose");

const dbStatus = {
  connected: false,
  fallbackMode: false,
  lastError: ""
};

const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
};

const getMongoDbNameFromUri = (mongoUri = "") => {
  try {
    const parsed = new URL(mongoUri);
    const pathname = String(parsed.pathname || "").replace(/^\/+/, "");
    return pathname.split("/")[0]?.trim() || "";
  } catch {
    return "";
  }
};

const normalizeMongoUri = (value = "") => {
  let mongoUri = String(value || "").trim();

  if (
    mongoUri.startsWith("MONGO_URI=") ||
    mongoUri.startsWith("MONGODB_URL=") ||
    mongoUri.startsWith("MONGODB_URI=")
  ) {
    mongoUri = mongoUri.slice(mongoUri.indexOf("=") + 1).trim();
  }

  mongoUri = mongoUri.replace(/^['"]+|['";]+$/g, "").trim();
  return mongoUri;
};

const connectDB = async () => {
  const isProduction = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  const skipDbConnect = parseBoolean(process.env.SKIP_DB_CONNECT, false);
  const mongoUri = normalizeMongoUri(process.env.MONGO_URI);
  const overrideDbName = String(process.env.MONGO_DB_NAME || "").trim();
  const uriDbName = getMongoDbNameFromUri(mongoUri);
  const activeDbName = overrideDbName || uriDbName;
  mongoose.set("bufferCommands", false);

  if (skipDbConnect) {
    dbStatus.connected = false;
    dbStatus.fallbackMode = true;
    dbStatus.lastError = "SKIP_DB_CONNECT is enabled";
    console.warn("SKIP_DB_CONNECT is enabled. Starting in local auth fallback mode.");
    return;
  }

  if (!mongoUri) {
    dbStatus.connected = false;
    dbStatus.fallbackMode = true;
    dbStatus.lastError = "MONGO_URI is missing";
    if (isProduction) {
      throw new Error("MONGO_URI is missing in production");
    }

    console.warn("MONGO_URI is missing. Starting in local auth fallback mode.");
    return;
  }

  console.log("DEBUG MONGO_URI:", mongoUri);

  if (!mongoUri.startsWith("mongodb://") && !mongoUri.startsWith("mongodb+srv://")) {
    const schemeError = new Error(
      'Invalid MONGO_URI scheme. Expected connection string to start with "mongodb://" or "mongodb+srv://".'
    );

    if (isProduction) {
      throw schemeError;
    }

    console.error("MongoDB connection failed:", schemeError.message);
    dbStatus.connected = false;
    dbStatus.fallbackMode = true;
    dbStatus.lastError = schemeError.message;
    console.warn("Starting without MongoDB. Auth will use local file fallback.");
    return;
  }

  if (mongoUri.includes("<db_password>")) {
    const placeholderError = new Error(
      "MONGO_URI still contains the <db_password> placeholder. Replace it with the real Atlas database user password."
    );

    if (isProduction) {
      throw placeholderError;
    }

    console.error(placeholderError.message);
    dbStatus.connected = false;
    dbStatus.fallbackMode = true;
    dbStatus.lastError = placeholderError.message;
    console.warn("Starting without MongoDB. Auth will use local file fallback.");
    return;
  }

  if (overrideDbName && uriDbName && overrideDbName !== uriDbName) {
    console.warn(
      `[runtime-warning] MONGO_DB_NAME (${overrideDbName}) overrides URI database name (${uriDbName}).`
    );
  }

  try {
    await mongoose.connect(
      mongoUri,
      overrideDbName
        ? {
            dbName: overrideDbName
          }
        : undefined
    );
    dbStatus.connected = true;
    dbStatus.fallbackMode = false;
    dbStatus.lastError = "";
    console.log(`MongoDB Connected${activeDbName ? ` (${activeDbName})` : ""}`);
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
    dbStatus.connected = false;
    dbStatus.fallbackMode = !isProduction;
    dbStatus.lastError = String(error?.message || error || "");

    const normalizedMessage = String(error?.message || "").toLowerCase();

    if (normalizedMessage.includes("authentication failed") || normalizedMessage.includes("bad auth")) {
      console.error(
        "MongoDB Atlas rejected the username/password in backend/.env. Reset the Atlas database user password and update MONGO_URI."
      );
      console.error(
        "If the password contains special characters like @, :, /, ?, #, or %, URL-encode it before placing it in MONGO_URI."
      );
    } else if (
      normalizedMessage.includes("querysrv") ||
      normalizedMessage.includes("enotfound") ||
      normalizedMessage.includes("econnrefused") ||
      normalizedMessage.includes("timed out")
    ) {
      console.error(
        "MongoDB Atlas could not be reached. Check Atlas Network Access, your internet connection, and DNS/network restrictions."
      );
    } else if (
      error?.codeName === "DatabaseDifferCase" ||
      normalizedMessage.includes("db already exists with different case")
    ) {
      console.error(
        "MongoDB database name case mismatch. Use the exact same database casing in Atlas and MONGO_URI/MONGO_DB_NAME (example: restaurantCRM)."
      );
    }

    if (isProduction) {
      throw error;
    }

    console.warn("Starting without MongoDB. Auth will use local file fallback.");
  }
};

const getDbStatus = () => ({
  ...dbStatus,
  mongooseReadyState: mongoose.connection.readyState
});

module.exports = {
  connectDB,
  getDbStatus
};
