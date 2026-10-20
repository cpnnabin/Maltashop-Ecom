/**
 * Saga flow test: the REAL Order and Inventory business code talking to each other through a fake
 * in-memory broker and in-memory databases. No Docker, PostgreSQL or RabbitMQ needed.
 *
 * Every message that crosses the "broker" is also validated against the JSON schemas in /contracts,
 * so this test fails if either service starts sending something the contract does not allow.
 */
const Ajv = require('ajv');

const mockOrders = new Map();
const mockStock = new Map();
const mockReservations = new Map();
const mockBus = { messages: [], validators: {} };

function mockQuiet() {
  const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return log; } };
  return { logger: log, withCorrelationId: () => log };
}

jest.mock('../order-service/src/logger', () => mockQuiet());
jest.mock('../inventory-service/src/logger', () => mockQuiet());

jest.mock('../order-service/src/db', () => ({
  createOrder: jest.fn(async (order) => {
    mockOrders.set(order.id, { id: order.id, status: order.status, correlation_id: order.correlationId, cancel_reason: null });
  }),
  transitionFromPending: jest.fn(async (id, status, reason = null) => {
    const order = mockOrders.get(id);
    if (!order || order.status !== 'PENDING') return false;
    order.status = status;
    order.cancel_reason = reason;
    return true;
  }),
  getOrder: jest.fn(async (id) => mockOrders.get(id))
}));

// Same contract as inventory-service/src/db.js reserve(): decide once, duplicates return the stored decision.
jest.mock('../inventory-service/src/db', () => ({
  reserve: jest.fn(async ({ orderId, items }) => {
    const existing = mockReservations.get(orderId);
    if (existing) return { ...existing, duplicate: true };
    const short = items.find((item) => (mockStock.get(item.sku) || 0) < item.quantity);
    let decision;
    if (short) {
      decision = { outcome: 'REJECTED', reason: `Insufficient stock for ${short.sku}` };
    } else {
      items.forEach((item) => mockStock.set(item.sku, mockStock.get(item.sku) - item.quantity));
      decision = { outcome: 'RESERVED', reason: null };
    }
    mockReservations.set(orderId, decision);
    return { ...decision, duplicate: false };
  })
}));

// The fake broker: delivers a published message straight to the other service's handler.
async function mockRoute(from, routingKey, message, correlationId) {
  const copy = JSON.parse(JSON.stringify(message)); // what travels over the wire is plain JSON
  mockBus.messages.push({ from, routingKey, message: copy, correlationId });
  const validate = mockBus.validators[routingKey];
  if (validate && !validate(copy)) {
    throw new Error(`${routingKey} violates its contract: ${JSON.stringify(validate.errors)}`);
  }
  if (routingKey === 'order.placed') {
    return require('../inventory-service/src/handlers').handleOrderPlaced(copy, { correlationId });
  }
  return require('../order-service/src/saga').handleStockOutcome(copy, { correlationId });
}
jest.mock('../order-service/src/rabbit', () => ({
  publish: jest.fn((key, message, correlationId) => mockRoute('order', key, message, correlationId))
}));
jest.mock('../inventory-service/src/rabbit', () => ({
  publish: jest.fn((key, message, correlationId) => mockRoute('inventory', key, message, correlationId))
}));

const saga = require('../order-service/src/saga');
const inventoryHandlers = require('../inventory-service/src/handlers');

const ajv = new Ajv({ allErrors: true });
mockBus.validators['order.placed'] = ajv.compile(require('../contracts/order-placed.schema.json'));
mockBus.validators['stock.reserved'] = ajv.compile(require('../contracts/stock-reserved.schema.json'));
mockBus.validators['stock.rejected'] = ajv.compile(require('../contracts/stock-rejected.schema.json'));

const correlationId = 'flow-correlation-001';

beforeEach(() => {
  mockOrders.clear();
  mockReservations.clear();
  mockStock.clear();
  mockStock.set('SKU-100', 50);
  mockStock.set('SKU-200', 5);
  mockBus.messages.length = 0;
});

describe('order saga across both services', () => {
  test('success path: stock is reserved and the order becomes CONFIRMED', async () => {
    const { orderId } = await saga.placeOrder({ customerId: 'cust-1', productId: 'SKU-100', quantity: 2 }, correlationId);

    expect(mockOrders.get(orderId).status).toBe('CONFIRMED');
    expect(mockStock.get('SKU-100')).toBe(48);
    expect(mockBus.messages.map((m) => m.routingKey)).toEqual(['order.placed', 'stock.reserved']);
  });

  test('failure path: insufficient stock cancels the order (compensating action) and keeps the reason', async () => {
    const { orderId } = await saga.placeOrder({ customerId: 'cust-1', productId: 'SKU-200', quantity: 6 }, correlationId);

    const order = mockOrders.get(orderId);
    expect(order.status).toBe('CANCELLED');
    expect(order.cancel_reason).toBe('Insufficient stock for SKU-200');
    expect(mockStock.get('SKU-200')).toBe(5);
    expect(mockBus.messages.map((m) => m.routingKey)).toEqual(['order.placed', 'stock.rejected']);
  });

  test('the correlation ID is the same in every message of one order', async () => {
    await saga.placeOrder({ customerId: 'cust-1', productId: 'SKU-100', quantity: 1 }, correlationId);

    expect(mockBus.messages.length).toBe(2);
    for (const { message, correlationId: propertyCorrelationId } of mockBus.messages) {
      expect(message.correlationId).toBe(correlationId);
      expect(propertyCorrelationId).toBe(correlationId);
    }
  });

  test('a duplicate OrderPlaced reserves stock only once and the order stays CONFIRMED', async () => {
    const { orderId } = await saga.placeOrder({ customerId: 'cust-1', productId: 'SKU-100', quantity: 2 }, correlationId);
    const orderPlaced = mockBus.messages[0].message;

    await inventoryHandlers.handleOrderPlaced(orderPlaced, { correlationId });
    await inventoryHandlers.handleOrderPlaced(orderPlaced, { correlationId });

    expect(mockStock.get('SKU-100')).toBe(48);
    expect(mockOrders.get(orderId).status).toBe('CONFIRMED');
  });

  test('a rejected order is still rejected if its message is redelivered after a restock', async () => {
    const { orderId } = await saga.placeOrder({ customerId: 'cust-1', productId: 'SKU-200', quantity: 6 }, correlationId);
    const orderPlaced = mockBus.messages[0].message;
    mockStock.set('SKU-200', 100);

    await inventoryHandlers.handleOrderPlaced(orderPlaced, { correlationId });

    expect(mockOrders.get(orderId).status).toBe('CANCELLED');
    expect(mockStock.get('SKU-200')).toBe(100);
  });

  test('a late, conflicting StockReserved cannot un-cancel an order', async () => {
    const { orderId } = await saga.placeOrder({ customerId: 'cust-1', productId: 'SKU-200', quantity: 6 }, correlationId);
    const lateReserved = {
      eventId: '44444444-4444-4444-8444-444444444444',
      type: 'StockReserved',
      version: 1,
      occurredAt: '2026-10-20T10:00:00Z',
      correlationId,
      data: { orderId }
    };

    const result = await saga.handleStockOutcome(lateReserved);

    expect(result.ignored).toBe('CONFLICT');
    expect(mockOrders.get(orderId).status).toBe('CANCELLED');
  });

  test('two orders are decided independently', async () => {
    const ok = await saga.placeOrder({ customerId: 'a', productId: 'SKU-200', quantity: 5 }, correlationId);
    const tooMany = await saga.placeOrder({ customerId: 'b', productId: 'SKU-200', quantity: 1 }, 'flow-correlation-002');

    expect(mockOrders.get(ok.orderId).status).toBe('CONFIRMED');
    expect(mockOrders.get(tooMany.orderId).status).toBe('CANCELLED');
    expect(mockStock.get('SKU-200')).toBe(0);
  });
});
