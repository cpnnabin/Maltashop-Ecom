// Message handling: acknowledge, retry, dead-letter. A fake amqplib stands in for the broker.
process.env.RETRY_DELAY_MS = '0';
process.env.MAX_DELIVERY_ATTEMPTS = '3';

const mockChannel = {
  on: jest.fn(),
  prefetch: jest.fn().mockResolvedValue(undefined),
  assertExchange: jest.fn().mockResolvedValue(undefined),
  assertQueue: jest.fn().mockResolvedValue(undefined),
  bindQueue: jest.fn().mockResolvedValue(undefined),
  consume: jest.fn().mockResolvedValue({ consumerTag: 'c1' }),
  publish: jest.fn(),
  sendToQueue: jest.fn(),
  ack: jest.fn(),
  nack: jest.fn(),
  close: jest.fn().mockResolvedValue(undefined)
};
const mockConnection = {
  on: jest.fn(),
  createConfirmChannel: jest.fn().mockResolvedValue(mockChannel),
  close: jest.fn().mockResolvedValue(undefined)
};
jest.mock('amqplib', () => ({ connect: jest.fn().mockResolvedValue(mockConnection) }));
jest.mock('../src/logger', () => {
  const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return log; } };
  return { logger: log, withCorrelationId: () => log };
});

const rabbit = require('../src/rabbit');
const { InvalidEventError } = require('../src/events');

function message(body, headers = {}) {
  const content = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return { content, properties: { correlationId: 'corr-12345', messageId: 'msg-1', headers } };
}

/** Registers a handler on the queue and returns the callback the broker would call per message. */
async function startConsumer(handler) {
  await rabbit.consumeStockOutcomes(handler);
  const calls = mockChannel.consume.mock.calls;
  return calls[calls.length - 1][1];
}

let topology;

beforeAll(async () => {
  await rabbit.connect();
  // Copy the calls now: beforeEach clears the mocks.
  topology = {
    queues: mockChannel.assertQueue.mock.calls.map((call) => [...call]),
    bindings: mockChannel.bindQueue.mock.calls.map((call) => [...call])
  };
});

beforeEach(() => {
  jest.clearAllMocks();
  mockChannel.publish.mockImplementation((exchange, key, buffer, options, callback) => callback(null));
  mockChannel.sendToQueue.mockImplementation((queue, buffer, options, callback) => callback(null));
});

describe('topology', () => {
  test('declares a durable queue for stock outcomes with a dead-letter queue', () => {
    const names = topology.queues.map((call) => call[0]);
    expect(names).toContain('order.stock-outcome');
    expect(names).toContain('order.stock-outcome.dlq');
    const main = topology.queues.find((call) => call[0] === 'order.stock-outcome');
    expect(main[1]).toMatchObject({ durable: true, deadLetterExchange: 'orders.dlx' });
    expect(topology.bindings).toContainEqual(['order.stock-outcome', 'orders', 'stock.*']);
  });
});

describe('publish', () => {
  test('sends a persistent JSON message and waits for the broker to confirm', async () => {
    await rabbit.publish('order.placed', { eventId: 'e-1', type: 'OrderPlaced' }, 'corr-12345');
    const [exchange, key, buffer, options] = mockChannel.publish.mock.calls[0];
    expect(exchange).toBe('orders');
    expect(key).toBe('order.placed');
    expect(JSON.parse(buffer.toString())).toEqual({ eventId: 'e-1', type: 'OrderPlaced' });
    expect(options).toMatchObject({ persistent: true, contentType: 'application/json', correlationId: 'corr-12345', messageId: 'e-1' });
  });

  test('fails if the broker does not confirm the message', async () => {
    mockChannel.publish.mockImplementation((exchange, key, buffer, options, callback) => callback(new Error('nacked')));
    await expect(rabbit.publish('order.placed', { eventId: 'e-2' }, 'corr-12345')).rejects.toThrow('nacked');
  });
});

describe('consume', () => {
  test('acknowledges a message after the handler succeeded', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    const onMessage = await startConsumer(handler);
    const msg = message({ hello: 'world' });

    await onMessage(msg);

    expect(handler).toHaveBeenCalledWith({ hello: 'world' }, { correlationId: 'corr-12345', messageId: 'msg-1', attempts: 0 });
    expect(mockChannel.ack).toHaveBeenCalledWith(msg);
    expect(mockChannel.nack).not.toHaveBeenCalled();
  });

  test('dead-letters a message that is not valid JSON, without calling the handler', async () => {
    const handler = jest.fn();
    const onMessage = await startConsumer(handler);
    const msg = message('{not json');

    await onMessage(msg);

    expect(handler).not.toHaveBeenCalled();
    expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, false);
    expect(mockChannel.ack).not.toHaveBeenCalled();
  });

  test('dead-letters an invalid event at once instead of retrying it', async () => {
    const handler = jest.fn().mockRejectedValue(new InvalidEventError('bad event'));
    const onMessage = await startConsumer(handler);
    const msg = message({ type: 'Nonsense' });

    await onMessage(msg);

    expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, false);
    expect(mockChannel.sendToQueue).not.toHaveBeenCalled();
  });

  test('retries a temporary failure by re-queueing the message with a higher attempt count', async () => {
    const handler = jest.fn().mockRejectedValue(new Error('db down'));
    const onMessage = await startConsumer(handler);
    const msg = message({ a: 1 });

    await onMessage(msg);

    expect(mockChannel.sendToQueue).toHaveBeenCalledTimes(1);
    const [queue, content, options] = mockChannel.sendToQueue.mock.calls[0];
    expect(queue).toBe('order.stock-outcome');
    expect(content).toBe(msg.content);
    expect(options.headers['x-attempts']).toBe(1);
    expect(options.persistent).toBe(true);
    expect(mockChannel.ack).toHaveBeenCalledWith(msg);
    expect(mockChannel.nack).not.toHaveBeenCalled();
  });

  test('gives up and dead-letters after the last attempt', async () => {
    const handler = jest.fn().mockRejectedValue(new Error('db down'));
    const onMessage = await startConsumer(handler);
    const msg = message({ a: 1 }, { 'x-attempts': 2 });

    await onMessage(msg);

    expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, false);
    expect(mockChannel.sendToQueue).not.toHaveBeenCalled();
  });

  test('puts the message back on the queue if the retry itself cannot be scheduled', async () => {
    mockChannel.sendToQueue.mockImplementation((queue, buffer, options, callback) => callback(new Error('channel closed')));
    const handler = jest.fn().mockRejectedValue(new Error('db down'));
    const onMessage = await startConsumer(handler);
    const msg = message({ a: 1 });

    await onMessage(msg);

    expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, true);
  });

  test('ignores the null message sent when the broker cancels the consumer', async () => {
    const handler = jest.fn();
    const onMessage = await startConsumer(handler);
    await onMessage(null);
    expect(handler).not.toHaveBeenCalled();
    expect(mockChannel.ack).not.toHaveBeenCalled();
    expect(mockChannel.nack).not.toHaveBeenCalled();
  });
});
