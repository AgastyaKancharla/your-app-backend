const MB = 1024 * 1024;
const GB = 1024 * MB;

const PLAN_LIMITS = {
  STARTER: {
    code: "STARTER",
    features: {
      orders: true,
      menuManagement: true,
      dashboard: true,
      basicAnalytics: true,
      advancedReports: false,
      customerCRM: true,
      marketingTools: false,
      whatsappCampaigns: false,
      inventoryManagement: false,
      recipeCosting: false,
      expenseManagement: false,
      supplierManagement: false,
      purchaseOrders: false,
      documentVault: false,
      staffManagement: false,
      deliveryManagement: false,
      salesChannelIntegrations: false,
      packagingTracker: false,
      tableManagement: false,
      reservationSystem: false,
      prioritySupport: false,
      multiBranch: false,
      apiIntegrations: false,
      aiDemandPrediction: false
    },
    limits: {
      maxStaffUsers: 1,
      maxDocuments: 50,
      maxDocumentStorageBytes: 250 * MB,
      maxSingleDocumentBytes: 3 * MB,
      maxReportDays: 30
    }
  },
  GROWTH: {
    code: "GROWTH",
    features: {
      orders: true,
      menuManagement: true,
      dashboard: true,
      basicAnalytics: true,
      advancedReports: false,
      customerCRM: true,
      marketingTools: true,
      whatsappCampaigns: true,
      inventoryManagement: true,
      recipeCosting: true,
      expenseManagement: true,
      supplierManagement: true,
      purchaseOrders: true,
      documentVault: true,
      staffManagement: true,
      deliveryManagement: true,
      salesChannelIntegrations: true,
      packagingTracker: true,
      tableManagement: false,
      reservationSystem: false,
      prioritySupport: false,
      multiBranch: false,
      apiIntegrations: false,
      aiDemandPrediction: false
    },
    limits: {
      maxStaffUsers: 3,
      maxDocuments: 2000,
      maxDocumentStorageBytes: 5 * GB,
      maxSingleDocumentBytes: 15 * MB,
      maxReportDays: 180
    }
  },
  PRO: {
    code: "PRO",
    features: {
      orders: true,
      menuManagement: true,
      dashboard: true,
      basicAnalytics: true,
      advancedReports: true,
      customerCRM: true,
      marketingTools: true,
      whatsappCampaigns: true,
      inventoryManagement: true,
      recipeCosting: true,
      expenseManagement: true,
      supplierManagement: true,
      purchaseOrders: true,
      documentVault: true,
      staffManagement: true,
      deliveryManagement: true,
      salesChannelIntegrations: true,
      packagingTracker: true,
      tableManagement: true,
      reservationSystem: true,
      prioritySupport: true,
      multiBranch: true,
      apiIntegrations: true,
      aiDemandPrediction: false
    },
    limits: {
      maxStaffUsers: 999999,
      maxDocuments: 10000,
      maxDocumentStorageBytes: 15 * GB,
      maxSingleDocumentBytes: 20 * MB,
      maxReportDays: 365
    }
  },
  ENTERPRISE: {
    code: "ENTERPRISE",
    features: {
      orders: true,
      menuManagement: true,
      dashboard: true,
      basicAnalytics: true,
      advancedReports: true,
      customerCRM: true,
      marketingTools: true,
      whatsappCampaigns: true,
      inventoryManagement: true,
      recipeCosting: true,
      expenseManagement: true,
      supplierManagement: true,
      purchaseOrders: true,
      documentVault: true,
      staffManagement: true,
      deliveryManagement: true,
      salesChannelIntegrations: true,
      packagingTracker: true,
      tableManagement: true,
      reservationSystem: true,
      prioritySupport: true,
      multiBranch: true,
      apiIntegrations: true,
      aiDemandPrediction: true
    },
    limits: {
      maxStaffUsers: 999999,
      maxDocuments: 50000,
      maxDocumentStorageBytes: 100 * GB,
      maxSingleDocumentBytes: 20 * MB,
      maxReportDays: 3650
    }
  },
  // Legacy aliases retained for existing tenants.
  FREE: {
    code: "STARTER",
    features: {
      orders: true,
      menuManagement: true,
      dashboard: true,
      basicAnalytics: true,
      advancedReports: false,
      customerCRM: true,
      marketingTools: false,
      whatsappCampaigns: false,
      inventoryManagement: false,
      recipeCosting: false,
      expenseManagement: false,
      supplierManagement: false,
      purchaseOrders: false,
      documentVault: false,
      staffManagement: false,
      deliveryManagement: false,
      salesChannelIntegrations: false,
      packagingTracker: false,
      tableManagement: false,
      reservationSystem: false,
      prioritySupport: false,
      multiBranch: false,
      apiIntegrations: false,
      aiDemandPrediction: false
    },
    limits: {
      maxStaffUsers: 1,
      maxDocuments: 50,
      maxDocumentStorageBytes: 250 * MB,
      maxSingleDocumentBytes: 3 * MB,
      maxReportDays: 30
    }
  },
  BASIC: {
    code: "GROWTH",
    features: {
      orders: true,
      menuManagement: true,
      dashboard: true,
      basicAnalytics: true,
      advancedReports: false,
      customerCRM: true,
      marketingTools: true,
      whatsappCampaigns: true,
      inventoryManagement: true,
      recipeCosting: true,
      expenseManagement: true,
      supplierManagement: true,
      purchaseOrders: true,
      documentVault: true,
      staffManagement: true,
      deliveryManagement: true,
      salesChannelIntegrations: true,
      packagingTracker: true,
      tableManagement: false,
      reservationSystem: false,
      prioritySupport: false,
      multiBranch: false,
      apiIntegrations: false,
      aiDemandPrediction: false
    },
    limits: {
      maxStaffUsers: 3,
      maxDocuments: 2000,
      maxDocumentStorageBytes: 5 * GB,
      maxSingleDocumentBytes: 15 * MB,
      maxReportDays: 180
    }
  }
};

const normalizePlanCode = (value) => {
  const normalized = String(value || "STARTER").trim().toUpperCase();
  if (normalized === "FREE") {
    return "STARTER";
  }
  if (normalized === "BASIC") {
    return "GROWTH";
  }
  return normalized;
};

const resolvePlanDefinition = (value) => {
  const code = normalizePlanCode(value);
  return PLAN_LIMITS[code] || PLAN_LIMITS.STARTER;
};

module.exports = {
  PLAN_LIMITS,
  normalizePlanCode,
  resolvePlanDefinition
};
