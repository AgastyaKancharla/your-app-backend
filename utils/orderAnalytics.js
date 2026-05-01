const { isCompletedOrderStatus } = require("./accessControl");

const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const getOrderAmount = (order = {}) => toNumber(order.grandTotal || order.totalAmount);

const getCompletedRevenueOrders = (orders = []) =>
  (Array.isArray(orders) ? orders : []).filter((order) => isCompletedOrderStatus(order?.status));

const sumCompletedRevenue = (orders = []) =>
  getCompletedRevenueOrders(orders).reduce((sum, order) => sum + getOrderAmount(order), 0);

const averageCompletedOrderValue = (orders = []) => {
  const completedOrders = getCompletedRevenueOrders(orders);
  if (completedOrders.length === 0) {
    return 0;
  }

  return sumCompletedRevenue(completedOrders) / completedOrders.length;
};

const aggregateCompletedItems = (orders = []) => {
  const itemMap = {};

  getCompletedRevenueOrders(orders).forEach((order) => {
    (Array.isArray(order?.items) ? order.items : []).forEach((item) => {
      const name = String(item?.name || "").trim();
      if (name.length === 0) {
        return;
      }

      if (itemMap[name] === undefined) {
        itemMap[name] = {
          quantity: 0,
          revenue: 0
        };
      }

      itemMap[name].quantity += toNumber(item.quantity);
      itemMap[name].revenue += toNumber(item.quantity) * toNumber(item.price);
    });
  });

  return itemMap;
};

module.exports = {
  toNumber,
  getOrderAmount,
  getCompletedRevenueOrders,
  sumCompletedRevenue,
  averageCompletedOrderValue,
  aggregateCompletedItems
};
