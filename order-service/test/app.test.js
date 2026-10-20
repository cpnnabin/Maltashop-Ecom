// HTTP API tests. The database and broker are replaced by mocks; the real Express app, validation and saga run.
jest.mock('../src/db', () => ({
  ping: jest.fn(),
  createOrder: jest.fn(),
  getOrder: jest.fn(),
  transitionFromPending: jest.fn()
}));
jest.mock('../src/rabbit', () => ({ publish: jest.fn(), isConnected: jest.fn() }));
jest.mock('../src/logger', () => {
  const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return log; } };
  return { logger: log, withCorrelationId: () => log };
});

const db = require('../src/db');
const rabbit = require('../src/rabbit');
const app = require('../src/app');

let server;
let base;

beforeAll(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  jest.resetAllMocks();
  db.createOrder.mockResolvedValue(undefined);
  db.ping.mockResolvedValue(undefined);
  rabbit.publish.mockResolvedValue(undefined);
  rabbit.isConnected.mockReturnValue(true);
});

function postOrder(body, headers = {}) {
  return fetch(`${base}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

describe('health and readiness', () => {
  test('GET /health is a liveness check', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', service: 'order-service' });
  });

  test('GET /ready is 200 when the database and broker are reachable', async () => {
    const res = await fetch(`${base}/ready`);
    expect(res.status).toBe(200);
    expect((await res.json()).checks).toEqual({ database: 'ok', broker: 'ok' });
  });

  test('GET /ready is 503 when the database is down', async () => {
    db.ping.mockRejectedValue(new Error('down'));
    const res = await fetch(`${base}/ready`);
    expect(res.status).toBe(503);
    expect((await res.json()).checks.database).toBe('down');
  });

  test('GET /ready is 503 when the broker is down', async () => {
    rabbit.isConnected.mockReturnValue(false);
    const res = await fetch(`${base}/ready`);
    expect(res.status).toBe(503);
  });
});

describe('POST /orders', () => {
  test('returns 202 with the order id and PENDING status, and echoes a valid correlation ID', async () => {
    const res = await postOrder({ customerId: 'cust-001', productId: 'SKU-100', quantity: 2 }, { 'x-correlation-id': 'demo-corr-001' });
    expect(res.status).toBe(202);
    expect(res.headers.get('x-correlation-id')).toBe('demo-corr-001');
    const body = await res.json();
    expect(body.status).toBe('PENDING');
    expect(body.orderId).toMatch(/^[0-9a-f-]{36}$/);
    expect(rabbit.publish).toHaveBeenCalledTimes(1);
  });

  test('generates a correlation ID when none (or an unusable one) is supplied', async () => {
    const res = await postOrder({ customerId: 'c', productId: 'SKU-100', quantity: 1 }, { 'x-correlation-id': 'short' });
    expect(res.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('returns 400 with details for a missing or invalid field, and publishes nothing', async () => {
    const res = await postOrder({ customerId: 'c', productId: 'SKU-100', quantity: 0 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid request');
    expect(body.details.length).toBe(1);
    expect(db.createOrder).not.toHaveBeenCalled();
    expect(rabbit.publish).not.toHaveBeenCalled();
  });

  test('returns 400 for a body that is not valid JSON', async () => {
    const res = await postOrder('{broken');
    expect(res.status).toBe(400);
  });

  test('returns 500 when the order cannot be sent for processing', async () => {
    rabbit.publish.mockRejectedValue(new Error('broker down'));
    db.transitionFromPending.mockResolvedValue(true);
    const res = await postOrder({ customerId: 'c', productId: 'SKU-100', quantity: 1 });
    expect(res.status).toBe(500);
  });
});

describe('GET /orders/:id', () => {
  const id = '11111111-1111-4111-8111-111111111111';

  test('returns the order with its status', async () => {
    db.getOrder.mockResolvedValue({ id, status: 'CONFIRMED' });
    const res = await fetch(`${base}/orders/${id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, status: 'CONFIRMED' });
  });

  test('returns 404 for an unknown order', async () => {
    db.getOrder.mockResolvedValue(undefined);
    const res = await fetch(`${base}/orders/${id}`);
    expect(res.status).toBe(404);
  });

  test('returns 400 (not 500) for an id that is not a UUID', async () => {
    const res = await fetch(`${base}/orders/not-a-uuid`);
    expect(res.status).toBe(400);
    expect(db.getOrder).not.toHaveBeenCalled();
  });
});
