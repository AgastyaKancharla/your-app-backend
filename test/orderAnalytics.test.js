const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getCompletedRevenueOrders,
  sumCompletedRevenue,
  averageCompletedOrderValue,
  aggregateCompletedItems
} = require("../utils/orderAnalytics");

test("completed revenue helpers exclude preparing and cancelled orders", () => {
  const orders = [
    {
      status: "PREPARING",
      totalAmount: 105,
      items: [{ name: "Burger", quantity: 1, price: 100 }]
    },
    {
      status: "COMPLETED",
      totalAmount: 210,
      items: [{ name: "Burger", quantity: 2, price: 100 }]
    },
    {
      status: "CANCELLED",
      totalAmount: 315,
      items: [{ name: "Burger", quantity: 3, price: 100 }]
    }
  ];

  assert.equal(getCompletedRevenueOrders(orders).length, 1);
  assert.equal(sumCompletedRevenue(orders), 210);
  assert.equal(averageCompletedOrderValue(orders), 210);
  assert.deepEqual(aggregateCompletedItems(orders), {
    Burger: {
      quantity: 2,
      revenue: 200
    }
  });
});

test("completed revenue helpers use grand total when available", () => {
  const orders = [
    {
      status: "COMPLETED",
      totalAmount: 100,
      grandTotal: 118,
      items: [{ name: "Pasta", quantity: 1, price: 100 }]
    },
    {
      status: "READY",
      totalAmount: 100,
      grandTotal: 118,
      items: [{ name: "Pasta", quantity: 1, price: 100 }]
    }
  ];

  assert.equal(sumCompletedRevenue(orders), 118);
  assert.equal(averageCompletedOrderValue(orders), 118);
});
