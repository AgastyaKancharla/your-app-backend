require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });

const { assertRuntimeConfig, getRuntimeReadiness } = require("../config/runtime");

try {
  const result = assertRuntimeConfig();
  const readiness = getRuntimeReadiness();

  console.log("Runtime configuration is valid.");
  console.log(JSON.stringify({ storageRoot: result.storageRoot, readiness }, null, 2));
} catch (error) {
  console.error("Runtime configuration is invalid.");
  console.error(error.message || String(error));
  process.exitCode = 1;
}
