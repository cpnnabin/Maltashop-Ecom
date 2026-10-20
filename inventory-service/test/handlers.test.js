jest.mock('../src/db', () => ({ reserve: jest.fn() }));
jest.mock('../src/rabbit', () => ({ publish: jest.fn() }));
jest.mock('../src/logger', () => {
  const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return log; } };
  return { logger: log, withCorrelationId: () => log };
});

const db = require('../src/db');
const rabbit = require('../src/rabbit');
const { handleOrderPlaced } = require('../src/handlers');
const { InvalidEventError } = require('../src/events');

const orderId = '11111111-1111-4111-8111-111111111111';
const correlationId = 'test-correlation-123';

function orderPlaced(items = [{ sku: 'SKU-100', quantity: 2 }]) {
  return {
    eventId: '33333333-3333-4333-8333-333333333333',
    type: 'OrderPlaced',
    version: 1,
    occurredAt: '2026-10-20T10:00:00Z',
    correlationId,
    data: { orderId, customerId: 'cust-1', items }
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  rabbit.publish.mockResolvedValue(undefined);
});

describe('handleOrderPlaced', () => {
  test('publishes StockReserved when the stock was reserved', async () => {
    db.reserve.mockResolvedValue({ outcome: 'RESERVED', reason: null, duplicate: false });

    await handleOrderPlaced(orderPlaced());

    expect(db.reserve).toHaveBeenCalledWith({ orderId, items: [{ sku: 'SKU-100', quantity: 2 }], correlationId });
    const [routingKey, event, publishedCorrelationId] = rabbit.publish.mock.calls[0];
    expect(routingKey).toBe('stock.reserved');
    expect(publishedCorrelationId).toBe(correlationId);
    expect(event).toMatchObject({ type: 'StockReserved', version: 1, correlationId, data: { orderId } });
  });

  test('publishes StockRejected with the reason when stock is insufficient', async () => {
    db.reserve.mockResolvedValue({ outcome: 'REJECTED', reason: 'Insufficient stock for SKU-200', duplicate: false });

    await handleOrderPlaced(orderPlaced([{ sku: 'SKU-200', quantity: 6 }]));

    const [routingKey, event] = rabbit.publish.mock.calls[0];
    expect(routingKey).toBe('stock.rejected');
    expect(event).toMatchObject({ type: 'StockRejected', data: { orderId, reason: 'Insufficient stock for SKU-200' } });
  });

  test('a duplicate OrderPlaced re-publishes the stored decision without reserving again', async () => {
    db.reserve.mockResolvedValue({ outcome: 'RESERVED', reason: null, duplicate: true });

    await handleOrderPlaced(orderPlaced());

    expect(db.reserve).toHaveBeenCalledTimes(1);
    expect(rabbit.publish.mock.calls[0][0]).toBe('stock.reserved');
  });

  test('falls back to the message property for the correlation ID if the event has none', async () => {
    db.reserve.mockResolvedValue({ outcome: 'RESERVED', reason: null, duplicate: false });
    const event = orderPlaced();
    delete event.correlationId;

    await handleOrderPlaced(event, { correlationId: 'from-properties' });

    expect(db.reserve.mock.calls[0][0].correlationId).toBe('from-properties');
    expect(rabbit.publish.mock.calls[0][2]).toBe('from-properties');
  });

  test('an invalid message throws a permanent error and never touches stock', async () => {
    await expect(handleOrderPlaced({ type: 'OrderPlaced', version: 1, data: {} })).rejects.toThrow(InvalidEventError);
    expect(db.reserve).not.toHaveBeenCalled();
    expect(rabbit.publish).not.toHaveBeenCalled();
  });

  test('a database failure is passed on (the message is retried, then dead-lettered)', async () => {
    db.reserve.mockRejectedValue(new Error('db down'));
    await expect(handleOrderPlaced(orderPlaced())).rejects.toThrow('db down');
    expect(rabbit.publish).not.toHaveBeenCalled();
  });

  test('a publish failure is passed on, so a redelivery can repair it', async () => {
    db.reserve.mockResolvedValue({ outcome: 'RESERVED', reason: null, duplicate: false });
    rabbit.publish.mockRejectedValue(new Error('broker down'));
    await expect(handleOrderPlaced(orderPlaced())).rejects.toThrow('broker down');
  });
});
