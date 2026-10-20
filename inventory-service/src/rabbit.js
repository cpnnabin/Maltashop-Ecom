const amqp = require('amqplib');
const { logger, withCorrelationId } = require('./logger');

// Topology owned by the Inventory service
const EXCHANGE = 'orders';
const DEAD_LETTER_EXCHANGE = 'orders.dlx';
const ORDER_PLACED_QUEUE = 'inventory.order-placed';
const ORDER_PLACED_DLQ = 'inventory.order-placed.dlq';
const ORDER_PLACED_BINDING = 'order.placed';

const MAX_ATTEMPTS = Number(process.env.MAX_DELIVERY_ATTEMPTS) || 3;
const RETRY_DELAY_MS = process.env.RETRY_DELAY_MS !== undefined ? Number(process.env.RETRY_DELAY_MS) : 1000;

let connection;
let channel;
let connecting;
let closing = false;

async function openConnection() {
  const url = process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq:5672';
  connection = await amqp.connect(url);
  connection.on('error', (err) => logger.error({ err }, 'RabbitMQ connection error'));
  connection.on('close', () => {
    if (closing) return;
    // Exit so the container restart policy brings the service back with a fresh connection.
    logger.error('RabbitMQ connection closed unexpectedly - exiting');
    process.exit(1);
  });

  // A confirm channel lets publish() wait until the broker has accepted the message.
  channel = await connection.createConfirmChannel();
  channel.on('error', (err) => logger.error({ err }, 'RabbitMQ channel error'));
  await channel.prefetch(10);

  await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
  await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'direct', { durable: true });

  // Messages that fail for good end up in the dead-letter queue instead of looping forever.
  await channel.assertQueue(ORDER_PLACED_DLQ, { durable: true });
  await channel.bindQueue(ORDER_PLACED_DLQ, DEAD_LETTER_EXCHANGE, ORDER_PLACED_QUEUE);
  await channel.assertQueue(ORDER_PLACED_QUEUE, {
    durable: true,
    deadLetterExchange: DEAD_LETTER_EXCHANGE,
    deadLetterRoutingKey: ORDER_PLACED_QUEUE
  });
  await channel.bindQueue(ORDER_PLACED_QUEUE, EXCHANGE, ORDER_PLACED_BINDING);
  return channel;
}

async function connect() {
  if (channel) return channel;
  if (!connecting) {
    connecting = openConnection().catch((err) => {
      connecting = undefined;
      throw err;
    });
  }
  return connecting;
}

function isConnected() {
  return Boolean(channel) && !closing;
}

/** Publishes a persistent JSON message and resolves once the broker has confirmed it. */
async function publish(routingKey, message, correlationId) {
  const ch = await connect();
  await new Promise((resolve, reject) => {
    try {
      ch.publish(
        EXCHANGE,
        routingKey,
        Buffer.from(JSON.stringify(message)),
        {
          persistent: true,
          contentType: 'application/json',
          correlationId,
          messageId: message.eventId,
          type: message.type,
          timestamp: Math.floor(Date.now() / 1000)
        },
        (err) => (err ? reject(err) : resolve())
      );
    } catch (err) {
      reject(err);
    }
  });
}

function safely(action, what) {
  try {
    action();
  } catch (err) {
    logger.error({ err }, `Could not ${what} (channel closed?)`);
  }
}

/**
 * Consumes a queue with explicit error handling:
 *  - unreadable JSON or a permanently invalid message -> logged, dead-lettered, never retried
 *  - temporary failure (for example the database is down) -> retried up to MAX_ATTEMPTS, then dead-lettered
 *  - success -> acknowledged
 * Every failure is logged with the correlation ID.
 */
async function consume(queue, handler) {
  const ch = await connect();
  await ch.consume(queue, async (msg) => {
    if (!msg) return; // consumer cancelled by the broker

    const props = msg.properties || {};
    const attempts = Number((props.headers && props.headers['x-attempts']) || 0);
    const log = withCorrelationId(props.correlationId);

    let body;
    try {
      body = JSON.parse(msg.content.toString('utf8'));
    } catch (err) {
      log.error({ err, queue }, 'Message is not valid JSON - dead-lettering');
      safely(() => ch.nack(msg, false, false), 'nack message');
      return;
    }

    try {
      await handler(body, { correlationId: props.correlationId, messageId: props.messageId, attempts });
      safely(() => ch.ack(msg), 'ack message');
    } catch (err) {
      if (err && err.permanent) {
        log.error({ err, queue, messageId: props.messageId }, 'Invalid message - dead-lettering');
        safely(() => ch.nack(msg, false, false), 'nack message');
        return;
      }
      if (attempts + 1 >= MAX_ATTEMPTS) {
        log.error({ err, queue, attempts: attempts + 1 }, 'Giving up after repeated failures - dead-lettering');
        safely(() => ch.nack(msg, false, false), 'nack message');
        return;
      }
      log.warn({ err, queue, attempt: attempts + 1, maxAttempts: MAX_ATTEMPTS }, 'Processing failed - will retry');
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (attempts + 1)));
      try {
        await new Promise((resolve, reject) => {
          ch.sendToQueue(
            queue,
            msg.content,
            { ...props, persistent: true, headers: { ...(props.headers || {}), 'x-attempts': attempts + 1 } },
            (e) => (e ? reject(e) : resolve())
          );
        });
        safely(() => ch.ack(msg), 'ack message');
      } catch (republishErr) {
        log.error({ err: republishErr }, 'Could not schedule retry - returning message to the queue');
        safely(() => ch.nack(msg, false, true), 'nack message');
      }
    }
  });
}

function consumeOrderPlaced(handler) {
  return consume(ORDER_PLACED_QUEUE, handler);
}

async function close() {
  closing = true;
  try {
    if (channel) await channel.close();
    if (connection) await connection.close();
  } catch (err) {
    logger.warn({ err }, 'Error while closing RabbitMQ');
  }
}

module.exports = {
  connect,
  publish,
  consume,
  consumeOrderPlaced,
  isConnected,
  close,
  ORDER_PLACED_QUEUE,
  ORDER_PLACED_DLQ
};
