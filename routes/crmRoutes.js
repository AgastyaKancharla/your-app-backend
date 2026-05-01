const express = require("express");

const requirePermission = require("../middleware/requirePermission");
const { requirePlanFeature } = require("../middleware/planLimitMiddleware");
const {
  createCampaign,
  createCustomer,
  getAnalytics,
  getCustomerProfile,
  listCampaigns,
  listCustomers,
  updateCustomer
} = require("../services/crmService");

const router = express.Router();

router.get(
  "/customers",
  requirePermission("crm.view"),
  requirePlanFeature("customerCRM", {
    requiredPlan: "GROWTH",
    message: "CRM customer insights are available on GROWTH and above plans."
  }),
  async (req, res) => {
    try {
      const data = await listCustomers(req, req.query);
      return res.json(data);
    } catch (err) {
      if (err?.status) {
        return res.status(err.status).json({ message: err.message });
      }

      return res.serverError(err);
    }
  }
);

router.get(
  "/customers/:id",
  requirePermission("crm.view"),
  requirePlanFeature("customerCRM", {
    requiredPlan: "GROWTH",
    message: "CRM customer profiles are available on GROWTH and above plans."
  }),
  async (req, res) => {
    try {
      const data = await getCustomerProfile(req, req.params.id);
      return res.json(data);
    } catch (err) {
      if (err?.status) {
        return res.status(err.status).json({ message: err.message });
      }

      return res.serverError(err);
    }
  }
);

router.post(
  "/customers",
  requirePermission("crm.create"),
  requirePlanFeature("customerCRM", {
    requiredPlan: "GROWTH",
    message: "CRM customer management is available on GROWTH and above plans."
  }),
  async (req, res) => {
    try {
      const data = await createCustomer(req, req.body);
      return res.status(201).json(data);
    } catch (err) {
      if (err?.status) {
        return res.status(err.status).json({ message: err.message });
      }

      return res.serverError(err);
    }
  }
);

router.put(
  "/customers/:id",
  requirePermission("crm.update"),
  requirePlanFeature("customerCRM", {
    requiredPlan: "GROWTH",
    message: "CRM customer editing is available on GROWTH and above plans."
  }),
  async (req, res) => {
    try {
      const data = await updateCustomer(req, req.params.id, req.body);
      return res.json(data);
    } catch (err) {
      if (err?.status) {
        return res.status(err.status).json({ message: err.message });
      }

      return res.serverError(err);
    }
  }
);

router.get(
  "/analytics",
  requirePermission("crm.view"),
  requirePlanFeature("customerCRM", {
    requiredPlan: "GROWTH",
    message: "CRM analytics are available on GROWTH and above plans."
  }),
  async (req, res) => {
    try {
      const data = await getAnalytics(req);
      return res.json(data);
    } catch (err) {
      if (err?.status) {
        return res.status(err.status).json({ message: err.message });
      }

      return res.serverError(err);
    }
  }
);

router.get(
  "/campaigns",
  requirePermission("marketing.view"),
  requirePlanFeature("marketingTools", {
    requiredPlan: "GROWTH",
    message: "CRM marketing campaigns are available on GROWTH and above plans."
  }),
  async (req, res) => {
    try {
      const data = await listCampaigns(req);
      return res.json(data);
    } catch (err) {
      if (err?.status) {
        return res.status(err.status).json({ message: err.message });
      }

      return res.serverError(err);
    }
  }
);

router.post(
  "/campaigns",
  requirePermission("marketing.create"),
  requirePlanFeature("marketingTools", {
    requiredPlan: "GROWTH",
    message: "CRM campaign creation is available on GROWTH and above plans."
  }),
  async (req, res) => {
    try {
      const data = await createCampaign(req, req.body);
      return res.status(201).json(data);
    } catch (err) {
      if (err?.status) {
        return res.status(err.status).json({ message: err.message });
      }

      return res.serverError(err);
    }
  }
);

module.exports = router;
