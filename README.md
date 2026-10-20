# MaltaShop Prototype: "Place an Order" Flow

A small microservices prototype for the MaltaShop case study (Unit 5: Service-Oriented Architecture and Microservices Fundamentals). It shows an order being placed across two independent services **without a shared database or a distributed transaction**, using a message broker and a choreography saga with a compensating action.

## What the system is

| Component | Responsibility | Own data store |
|---|---|---|
| **order-service** (port 3000) | Accepts orders over REST, saves them as `PENDING`, publishes `OrderPlaced`, then sets the order to `CONFIRMED` (on `StockReserved`) or `CANCELLED` (on `StockRejected`) | PostgreSQL database `orders` |
| **inventory-service** (port 3001) | Consumes `OrderPlaced`, reserves stock in one local transaction, publishes `StockReserved` or `StockRejected` | PostgreSQL database `inventory` |
| **RabbitMQ** (5672, UI 15672) | Message broker (topic exchange `orders`, dead-letter exchange `orders.dlx`) | none |

The two services never call each other and never share a database. They only exchange events.

### The flow

```mermaid
sequenceDiagram
    participant C as Client
    participant O as Order service
    participant B as RabbitMQ
    participant I as Inventory service
    C->>O: POST /orders (X-Correlation-ID)
    O->>O: save order as PENDING
    O->>B: OrderPlaced (order.placed)
    O-->>C: 202 Accepted {orderId, status: PENDING}
    B->>I: OrderPlaced
    alt enough stock
        I->>I: reserve stock + record RESERVED (one local transaction)
        I->>B: StockReserved (stock.reserved)
        B->>O: StockReserved
        O->>O: order CONFIRMED
    else not enough stock
        I->>I: record REJECTED (stock untouched)
        I->>B: StockRejected (stock.rejected)
        B->>O: StockRejected
        O->>O: order CANCELLED (compensating action)
    end
```

## Get the code

Requirements: [Docker Desktop](https://www.docker.com/products/docker-desktop/) (with Docker Compose) and Git. Node.js 22 is only needed to run the tests or the services outside Docker.

```bash
git clone https://github.com/Melan-Parajuli7/Malta-Shop.git
cd Malta-Shop
```

## Run it

```bash
docker compose up --build
```

| URL | What |
|---|---|
| http://localhost:3000/health | Order service liveness |
| http://localhost:3000/ready | Order service readiness (database and broker reachable) |
| http://localhost:3001/health | Inventory service liveness |
| http://localhost:3001/ready | Inventory service readiness |
| http://localhost:3001/stock/SKU-100 | Current stock level |
| http://localhost:15672 | RabbitMQ management UI (default user/password `guest`/`guest`) |

Stop and delete the data: `docker compose down -v`

> **Upgrading from an older version of this project?** Run `docker compose down -v` once first. The Inventory database layout changed (`reservations` plus `reservation_items`), and the service stops with a clear message if it finds the old layout.

## Try it

```powershell
# Windows PowerShell
$body = @{ customerId = "cust-001"; productId = "SKU-100"; quantity = 2 } | ConvertTo-Json
Invoke-RestMethod -Uri http://localhost:3000/orders -Method POST -ContentType "application/json" `
  -Headers @{ "x-correlation-id" = "demo-corr-001" } -Body $body
```

```bash
# Linux / macOS / Git Bash
curl -X POST http://localhost:3000/orders -H "Content-Type: application/json" \
  -H "X-Correlation-ID: demo-corr-001" \
  -d '{"customerId":"cust-001","productId":"SKU-100","quantity":2}'

# status after a second: CONFIRMED
curl http://localhost:3000/orders/<orderId>

# see the same correlation ID in both services
docker compose logs order-service inventory-service | grep demo-corr-001
```

Seed stock: `SKU-100` (50 units) and `SKU-200` (5 units). Order 6 or more of `SKU-200` to see the `CANCELLED` path; the order then carries a `cancel_reason` such as `Insufficient stock for SKU-200`.

## API

| Method | Path | Service | Description |
|---|---|---|---|
| POST | `/orders` | Order | Body `{"customerId","productId","quantity"}` (`customerId` 1-100 characters, `productId` 3-40 characters, `quantity` a whole number 1-100). Returns `202` with `{orderId, status: "PENDING"}`, or `400` with `{error, details[]}` for invalid or missing fields or malformed JSON. |
| GET | `/orders/{id}` | Order | Order record. `status` is `PENDING`, `CONFIRMED` or `CANCELLED`. `400` if the id is not a UUID, `404` if unknown. |
| GET | `/health` | Both | Liveness: `200 {"status":"ok"}`. |
| GET | `/ready` | Both | Readiness: `200` when the database and the broker are reachable, otherwise `503` with the failing check. |
| GET | `/stock/{productId}` | Inventory | `{productId, available}` (read-only, for demos and the smoke test). |

Header `X-Correlation-ID` is optional on `POST /orders` (8-100 characters of letters, digits, `.`, `_`, `:`, `-`). It is generated when missing or unusable and is always returned in the response.

## Events (RabbitMQ topic exchange `orders`)

All events use one envelope: `eventId`, `type`, `version`, `occurredAt`, `correlationId`, `data`. The JSON Schemas in [`contracts/`](contracts) describe them and the contract tests enforce them.

| Event | Routing key | Published by | Consumed by (queue) | Schema |
|---|---|---|---|---|
| `OrderPlaced` | `order.placed` | Order | Inventory (`inventory.order-placed`) | `contracts/order-placed.schema.json` |
| `StockReserved` | `stock.reserved` | Inventory | Order (`order.stock-outcome`) | `contracts/stock-reserved.schema.json` |
| `StockRejected` | `stock.rejected` | Inventory | Order (`order.stock-outcome`) | `contracts/stock-rejected.schema.json` |

The correlation ID travels in the event body and in the AMQP `correlationId` property, and appears in the JSON logs (pino) of both services.

## Reliability

- **Durable and persistent:** queues are durable, messages are persistent, and publishing waits for the broker's confirmation (publisher confirms).
- **Acknowledge after processing:** a message is acknowledged only after it has been handled.
- **Failed messages do not loop forever:** an unreadable or invalid message is logged and sent to a dead-letter queue immediately. A temporary failure (for example the database is down) is retried up to 3 times (`MAX_DELIVERY_ATTEMPTS`), then dead-lettered. Dead-letter queues: `inventory.order-placed.dlq` and `order.stock-outcome.dlq`. Every failure is logged with the correlation ID.
- **Idempotent Inventory:** `reservations` has one row per order (primary key `order_id`) holding the decision, `RESERVED` or `REJECTED`. A redelivered `OrderPlaced` returns the stored decision and never reserves stock twice. A rejected order stays rejected even if stock is added later. Concurrent deliveries are serialised by a row lock on the stock rows.
- **Idempotent Order:** an order leaves `PENDING` exactly once (`UPDATE ... WHERE status = 'PENDING'`). A duplicate or conflicting late event (for example `StockReserved` after `CANCELLED`) is logged and ignored.
- **Repair after a crash:** Inventory publishes its answer again when it sees a duplicate, so a crash between "decision saved" and "answer published" is repaired by the redelivery.
- **Restarts:** if the broker connection is lost the service exits and Docker restarts it. Compose starts Inventory (and so its queue) before Order.

## Environment variables

| Variable | Default in compose | Description |
|---|---|---|
| `PORT` | `3000` (order) / `3001` (inventory) | HTTP port |
| `DATABASE_URL` | see `docker-compose.yml` | PostgreSQL connection string of the service's own database |
| `RABBITMQ_URL` | `amqp://guest:guest@rabbitmq:5672` | Broker connection string |
| `LOG_LEVEL` | `info` | pino log level |
| `MAX_DELIVERY_ATTEMPTS` | `3` | Tries per message before it is dead-lettered |
| `RETRY_DELAY_MS` | `1000` | Wait before a retry (multiplied by the attempt number) |

Compose-level overrides: copy [`.env.example`](.env.example) to `.env` and edit `RABBITMQ_USER`, `RABBITMQ_PASSWORD`, `ORDER_DB_PASSWORD`, `INVENTORY_DB_PASSWORD`, `LOG_LEVEL`. `order-service/.env.example` and `inventory-service/.env.example` list the variables for running a service outside Docker. The defaults are for a laptop only; change them for anything else. `.env` is git-ignored.

## Tests and CI

| What | Where | How to run |
|---|---|---|
| Unit tests (events, validation, saga logic, message handling, HTTP API) | `order-service/test`, `inventory-service/test` | `cd order-service && npm ci && npm test` (same for `inventory-service`) |
| Contract tests (events match the JSON Schemas in `contracts/`) and a saga flow test (both services' real code, in-memory broker and databases, every message validated against the schemas) | `tests/` | `cd tests && npm ci && npm test` |
| Database tests (real PostgreSQL: reserve, reject, duplicates, restock, concurrency) | `*/test/db.integration.test.js` | `TEST_DATABASE_URL=postgres://user:pass@localhost:5432/test npm run test:db` in each service (skipped when the variable is not set) |
| End-to-end smoke test (success, failure, duplicate event, dead-letter queue) | `scripts/smoke-test.js` | `docker compose up -d --build --wait` then `node scripts/smoke-test.js` (use a fresh stack: `docker compose down -v` first) |

`.github/workflows/ci.yml` runs on every push and pull request to `main`:

1. **Unit and contract tests**: `npm ci` and `npm test` for both services and for `tests/`. A job with no tests no longer passes silently.
2. **Database tests**: starts a PostgreSQL service container and runs the database tests.
3. **Docker**: builds both images, starts the whole system with Docker Compose, runs the smoke test and prints container logs if something fails.

## Project layout

```
order-service/       REST API, order saga, RabbitMQ consumer/publisher, tests
inventory-service/   stock reservation, RabbitMQ consumer/publisher, tests
contracts/           JSON Schemas for the three events
tests/               contract tests and the cross-service saga flow test
scripts/             end-to-end smoke test
docs/screenshots/    evidence screenshots
docker-compose.yml   the whole system (two services, two PostgreSQL databases, RabbitMQ)
```

## Known limitations (what to change before production)

- No transactional outbox: if the Order service crashes between saving the order and publishing the event, the order stays `PENDING`. (If publishing fails while the service is running, the order is cancelled instead.)
- The API accepts one product per order. The event format and the Inventory service already support up to 20 items per order, all-or-nothing.
- No Payment service; payment is described in the report only.
- No authentication or API gateway; no idempotency key on `POST /orders`.
- Retries wait inside the consumer; there is no delayed-retry queue. Dead-lettered messages must be inspected and replayed by hand (RabbitMQ management UI).
- No metrics or tracing (structured JSON logs only); readiness checks cover the database and the broker, not downstream business health.
- Single broker node and single database instances; default credentials.
