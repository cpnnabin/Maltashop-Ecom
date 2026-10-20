jest.mock('../src/db', () => ({
  createOrder: jest.fn(),
  transitionFromPending: jest.fn(),
  getOrder: jest.fn()
}));
jest.mock('../src/rabbit', () => ({ publish: jest.fn() }));
jest.mock('../src/logger', () => {
  const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return log; } };
  return { logger: log, withCorrelationId: () => log };
});

const db = require('../src/db');
const rabbit = require('../src/rabbit');
const saga = require('../src/saga');
const { InvalidEventError } = require('../src/events');

const orderId = '11111111-1111-4111-8111-111111111111';
const correlationId = 'test-correlation-123';
const reservedEvent = { eventId: '22222222-2222-4222-8222-222222222222', type: 'StockReserved', version: 1, occurredAt: '2026-10-20T10:00:00Z', correlationId, data: { orderId } };
const rejectedEvent = { ...reservedEvent, type: 'StockRejected', data: { orderId, reason: 'Insufficient stock for SKU-200' } };

beforeEach(() => {
  jest.resetAllMocks();
  db.createOrder.mockResolvedValue(undefined);
  rabbit.publish.mockResolvedValue(undefined);
});

describe('placeOrder', () => {
  test('saves the order as PENDING and publishes OrderPlaced with the same correlation ID', async () => {
    const result = await saga.placeOrder({ customerId: 'cust-1', productId: 'SKU-100', quantity: 2 }, correlationId);

    expect(result.status).toBe('PENDING');
    expect(result.orderId).toMatch(/^[0-9a-f-]{36}$/);

    const saved = db.createOrder.mock.calls[0][0];
    expect(saved).toMatchObject({ id: result.orderId, customerId: 'cust-1', productId: 'SKU-100', quantity: 2, status: 'PENDING', correlationId });

    expect(rabbit.publish).toHaveBeenCalledTimes(1);
    const [routingKey, event, publishedCorrelationId] = rabbit.publish.mock.calls[0];
    expect(routingKey).toBe('order.placed');
    expect(publishedCorrelationId).toBe(correlationId);
    expect(event).toMatchObject({
      type: 'OrderPlaced',
      version: 1,
      correlationId,
      data: { orderId: result.orderId, customerId: 'cust-1', items: [{ sku: 'SKU-100', quantity: 2 }] }
    });
  });

  test('cancels the order if the event cannot be published, and reports the error', async () => {
    rabbit.publish.mockRejectedValue(new Error('broker down'));
    db.transitionFromPending.mockResolvedValue(true);

    await expect(saga.placeOrder({ customerId: 'c', productId: 'SKU-100', quantity: 1 }, correlationId)).rejects.toThrow('broker down');

    const [id, status] = db.transitionFromPending.mock.calls[0];
    expect(id).toBe(db.createOrder.mock.calls[0][0].id);
    expect(status).toBe('CANCELLED');
  });

  test('does not publish anything if the order cannot be saved', async () => {
    db.createOrder.mockRejectedValue(new Error('db down'));
    await expect(saga.placeOrder({ customerId: 'c', productId: 'SKU-100', quantity: 1 }, correlationId)).rejects.toThrow('db down');
    expect(rabbit.publish).not.toHaveBeenCalled();
  });
});

describe('handleStockOutcome', () => {
  test('StockReserved confirms a PENDING order', async () => {
    db.transitionFromPending.mockResolvedValue(true);
    const result = await saga.handleStockOutcome(reservedEvent);
    expect(db.transitionFromPending).toHaveBeenCalledWith(orderId, 'CONFIRMED', null);
    expect(result).toEqual({ applied: true, status: 'CONFIRMED' });
  });

  test('StockRejected cancels a PENDING order and stores the reason (compensating action)', async () => {
    db.transitionFromPending.mockResolvedValue(true);
    const result = await saga.handleStockOutcome(rejectedEvent);
    expect(db.transitionFromPending).toHaveBeenCalledWith(orderId, 'CANCELLED', 'Insufficient stock for SKU-200');
    expect(result).toEqual({ applied: true, status: 'CANCELLED' });
  });

  test('a duplicate event is a harmless no-op', async () => {
    db.transitionFromPending.mockResolvedValue(false);
    db.getOrder.mockResolvedValue({ id: orderId, status: 'CONFIRMED' });
    const result = await saga.handleStockOutcome(reservedEvent);
    expect(result).toEqual({ applied: false, ignored: 'DUPLICATE' });
  });

  test('a conflicting late event never flips a decided order', async () => {
    db.transitionFromPending.mockResolvedValue(false);
    db.getOrder.mockResolvedValue({ id: orderId, status: 'CANCELLED' });
    const result = await saga.handleStockOutcome(reservedEvent);
    expect(result).toEqual({ applied: false, ignored: 'CONFLICT' });
  });

  test('an outcome for an unknown order is ignored, not retried forever', async () => {
    db.transitionFromPending.mockResolvedValue(false);
    db.getOrder.mockResolvedValue(undefined);
    const result = await saga.handleStockOutcome(reservedEvent);
    expect(result).toEqual({ applied: false, ignored: 'UNKNOWN_ORDER' });
  });

  test('an invalid message throws a permanent error and touches nothing', async () => {
    await expect(saga.handleStockOutcome({ type: 'Nonsense' })).rejects.toThrow(InvalidEventError);
    expect(db.transitionFromPending).not.toHaveBeenCalled();
  });

  test('a database failure is passed on so the message can be retried', async () => {
    db.transitionFromPending.mockRejectedValue(new Error('db down'));
    await expect(saga.handleStockOutcome(reservedEvent)).rejects.toThrow('db down');
  });
});
