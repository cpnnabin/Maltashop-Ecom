jest.mock('../src/db', () => ({ ping: jest.fn(), getStock: jest.fn() }));
jest.mock('../src/rabbit', () => ({ isConnected: jest.fn() }));
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
  db.ping.mockResolvedValue(undefined);
  rabbit.isConnected.mockReturnValue(true);
});

describe('inventory HTTP API', () => {
  test('GET /health is a liveness check', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', service: 'inventory-service' });
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
  });

  test('GET /ready is 503 when the broker is down', async () => {
    rabbit.isConnected.mockReturnValue(false);
    const res = await fetch(`${base}/ready`);
    expect(res.status).toBe(503);
  });

  test('GET /stock/:productId returns the available quantity', async () => {
    db.getStock.mockResolvedValue(48);
    const res = await fetch(`${base}/stock/SKU-100`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ productId: 'SKU-100', available: 48 });
    expect(db.getStock).toHaveBeenCalledWith('SKU-100');
  });

  test('GET /stock/:productId is 500 when the database fails', async () => {
    db.getStock.mockRejectedValue(new Error('db down'));
    const res = await fetch(`${base}/stock/SKU-100`);
    expect(res.status).toBe(500);
  });
});
