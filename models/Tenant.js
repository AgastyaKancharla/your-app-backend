const mongoose = require("mongoose");
const Restaurant = require("./Restaurant");

module.exports =
  mongoose.models.Tenant || mongoose.model("Tenant", Restaurant.schema, "restaurants");
