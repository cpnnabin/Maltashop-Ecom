#!/usr/bin/env node
/**
 * End-to-end smoke test against the RUNNING docker compose stack (no npm packages needed, Node 18+).
 *
 *   docker compose up -d --build --wait
 *   node scripts/smoke-test.js
 *
 * It checks, through the real services, database and RabbitMQ:
 *   1. input validation (400)                       4. a duplicate OrderPlaced reserves stock only once
 *   2. success path: PENDING -> CONFIRMED           5. a malformed message lands in the dead-letter queue
 *   3. failure path: PENDING -> CANCELLED           6. the correlation ID is returned to the caller
 * Run it on a fresh stack (docker compose down -v first) so the seed stock is untouched.
 */
const { randomUUID } = require('node:crypto');

const ORDER = process.env.ORDER_URL || 'http://localhost:3000';
const INVENTORY = process.env.INVENTORY_URL || 'http://localhost:3001';
const RABBIT = process.env.RABBITMQ_MGMT_URL || 'http://localhost:15672';
const RABBIT_AUTH = 'Basic ' + Buffer.from(`${process.env.RABBITMQ_USER || 'guest'}:${process.env.RABBITMQ_PASSWORD || 'guest'}`).toString('base64');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;

function pass(message) { console.log(`  PASS  ${message}`); }
function fail(message) { failures += 1; console.log(`  FAIL  ${message}`); }
function check(condition, message) { condition ? pass(message) : fail(message); return condition; }

async function waitFor(label, probe, timeoutMs = 20000, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await probe();
      if (last) return last;
    } catch (err) {
      last = undefined;
    }
    await sleep(everyMs);
  }
  throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for: ${label}`);
}

async function getJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch (err) { body = text; }
  return { status: res.status, headers: res.headers, body };
}

function postOrder(payload, correlationId) {
  return getJson(`${ORDER}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(correlationId ? { 'x-correlation-id': correlationId } : {}) },
    body: JSON.stringify(payload)
  });
}

const stockOf = async (sku) => (await getJson(`${INVENTORY}/stock/${sku}`)).body.available;

function publishToExchange(routingKey, payload, correlationId) {
  return getJson(`${RABBIT}/api/exchanges/%2F/orders/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: RABBIT_AUTH },
    body: JSON.stringify({
      properties: { delivery_mode: 2, content_type: 'application/json', correlation_id: correlationId },
      routing_key: routingKey,
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
      payload_encoding: 'string'
    })
  });
}

async function main() {
  console.log('Waiting for both services to be ready...');
  await waitFor('order-service /ready', async () => (await getJson(`${ORDER}/ready`)).status === 200, 90000, 1000);
  await waitFor('inventory-service /ready', async () => (await getJson(`${INVENTORY}/ready`)).status === 200, 90000, 1000);
  pass('both services report ready (database and broker reachable)');

  console.log('\n1. Validation');
  const bad = await postOrder({ customerId: 'smoke', productId: 'SKU-100', quantity: 0 });
  check(bad.status === 400, `POST /orders with quantity 0 -> 400 (got ${bad.status})`);

  console.log('\n2. Success path (SKU-100, quantity 2)');
  const stockBefore = await stockOf('SKU-100');
  const correlationId = `smoke-${Date.now()}`;
  const ok = await postOrder({ customerId: 'smoke-1', productId: 'SKU-100', quantity: 2 }, correlationId);
  check(ok.status === 202 && ok.body.status === 'PENDING', `POST /orders -> 202 PENDING (got ${ok.status} ${JSON.stringify(ok.body)})`);
  check(ok.headers.get('x-correlation-id') === correlationId, 'the correlation ID is returned in the response header');
  const confirmed = await waitFor('order CONFIRMED', async () => {
    const order = (await getJson(`${ORDER}/orders/${ok.body.orderId}`)).body;
    return order.status === 'CONFIRMED' ? order : undefined;
  });
  check(Boolean(confirmed), 'order became CONFIRMED');
  check((await stockOf('SKU-100')) === stockBefore - 2, `stock went from ${stockBefore} to ${stockBefore - 2}`);

  console.log('\n3. Failure path (SKU-200, quantity 6 > 5 in stock)');
  const stock200 = await stockOf('SKU-200');
  const rejected = await postOrder({ customerId: 'smoke-2', productId: 'SKU-200', quantity: 6 });
  check(rejected.status === 202, `POST /orders -> 202 (got ${rejected.status})`);
  const cancelled = await waitFor('order CANCELLED', async () => {
    const order = (await getJson(`${ORDER}/orders/${rejected.body.orderId}`)).body;
    return order.status === 'CANCELLED' ? order : undefined;
  });
  check(Boolean(cancelled), 'order became CANCELLED (compensating action)');
  check(/Insufficient stock/.test(cancelled.cancel_reason || ''), `cancel reason recorded: "${cancelled.cancel_reason}"`);
  check((await stockOf('SKU-200')) === stock200, 'stock for SKU-200 is unchanged');

  console.log('\n4. Duplicate OrderPlaced event (published twice straight to RabbitMQ)');
  const before = await stockOf('SKU-100');
  const duplicateOrderId = randomUUID();
  const event = {
    eventId: randomUUID(),
    type: 'OrderPlaced',
    version: 1,
    occurredAt: new Date().toISOString(),
    correlationId: 'smoke-duplicate-001',
    data: { orderId: duplicateOrderId, customerId: 'smoke-3', items: [{ sku: 'SKU-100', quantity: 3 }] }
  };
  const first = await publishToExchange('order.placed', event, 'smoke-duplicate-001');
  const second = await publishToExchange('order.placed', event, 'smoke-duplicate-001');
  check(first.status === 200 && first.body.routed === true && second.body.routed === true, 'both copies were routed to the Inventory queue');
  await waitFor('stock reserved once', async () => (await stockOf('SKU-100')) === before - 3);
  await sleep(2000); // give the second copy time to be processed
  check((await stockOf('SKU-100')) === before - 3, `stock decreased once (${before} -> ${before - 3}), not twice`);

  console.log('\n5. Malformed message goes to the dead-letter queue');
  const dlqName = 'inventory.order-placed.dlq';
  const dlqDepth = async () => (await getJson(`${RABBIT}/api/queues/%2F/${dlqName}`, { headers: { authorization: RABBIT_AUTH } })).body.messages || 0;
  const dlqBefore = await dlqDepth();
  await publishToExchange('order.placed', '{"type":"OrderPlaced","version":1,"data":{}}', 'smoke-bad-0001');
  await waitFor('message in dead-letter queue', async () => (await dlqDepth()) > dlqBefore, 30000, 1000);
  pass(`the invalid message is in ${dlqName} (not retried forever)`);

  console.log(failures === 0 ? '\nSMOKE TEST PASSED' : `\nSMOKE TEST FAILED (${failures} check(s))`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nSMOKE TEST ERROR: ${err.message}`);
  process.exit(1);
});
