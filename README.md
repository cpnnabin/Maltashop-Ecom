# MaltaShop Prototype: "Place an Order" Flow

A small microservices prototype for the MaltaShop case study (Unit 5: Service-Oriented Architecture and Microservices Fundamentals). It shows an order being placed across two independent services **without a shared database or a distributed transaction**, using a message broker and a choreography saga with a compensating action.

## What the system is

| Component | Responsibility | Own data store |
|---|---|---|
| **order-service** (port 3000) | Accepts orders over REST, saves them as `PENDING`, publishes `OrderPlaced`, cancels the order when it receives `order.failed` | PostgreSQL database `orders` |
| **inventory-service** (port 3001) | Consumes `OrderPlaced`, reserves stock in one local transaction, publishes `order.failed` when stock is insufficient | PostgreSQL database `inventory` |
| **RabbitMQ** | Message broker (topic exchange `orders`) | none |

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
    O-->>C: 202 Accepted {orderId, status}
    B->>I: OrderPlaced
    alt enough stock
        I->>I: reserve stock (one local transaction)
    else not enough stock
        I->>B: OrderFailed (order.failed)
        B->>O: OrderFailed
        O->>O: order CANCELLED (compensating action)
    end
```

## Get the code

Requirements: [Docker Desktop](https://www.docker.com/products/docker-desktop/) (with Docker Compose) and Git. Node.js is only needed to run the services or tests outside Docker.

```bash
git clone https://github.com/Melan-Parajuli7/Malta-Shop.git
cd Malta-Shop
```

## Run it

Requirement: Docker Desktop (includes Docker Compose).

```bash
docker compose up --build
```

| URL | What |
|---|---|
| http://localhost:3000/health | Order service health |
| http://localhost:3001/health | Inventory service health |
| http://localhost:15672 | RabbitMQ management UI (default user/password `guest`/`guest`) |

Stop and delete the data: `docker compose down -v`

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

# see the same correlation ID in both services
docker compose logs order-service inventory-service | grep demo-corr-001
```

Seed stock: `SKU-100` (50 units) and `SKU-200` (5 units). Order 6 or more of `SKU-200` to see the `CANCELLED` path (`GET /orders/<orderId>` after a second).

## API

| Method | Path | Service | Description |
|---|---|---|---|
| POST | `/orders` | Order | Body `{"customerId","productId","quantity"}`. Returns `202` with `{orderId, status: "PENDING"}`, or `400` if a field is missing. |
| GET | `/orders/{id}` | Order | Order record with its status: `PENDING` or `CANCELLED`. |
| GET | `/health` | Both | `200 {"status":"ok"}` (liveness only: it does not yet check the database or broker). |

Header `X-Correlation-ID` is optional on `POST /orders`; it is generated when missing and always returned.

## Events (RabbitMQ topic exchange `orders`)

| Event | Routing key | Published by | Consumed by (queue) |
|---|---|---|---|
| `OrderPlaced` | `order.placed` | Order | Inventory (`inventory.order.placed`) |
| `OrderFailed` | `order.failed` | Inventory | Order (`order.compensation`) |

Messages are persistent, queues are durable, and a message is acknowledged only after it has been processed. The correlation ID is carried in the message `correlationId` property.

## Environment variables (same for both services)

| Variable | Default in compose | Description |
|---|---|---|
| `PORT` | `3000` (order) / `3001` (inventory) | HTTP port |
| `DATABASE_URL` | see `docker-compose.yml` | PostgreSQL connection string of the service's own database |
| `RABBITMQ_URL` | `amqp://guest:guest@rabbitmq:5672` | Broker connection string |
| `LOG_LEVEL` | `info` | pino log level |

Compose-level overrides (optional `.env`, see `.env.example`): `RABBITMQ_USER`, `RABBITMQ_PASSWORD`, `ORDER_DB_PASSWORD`, `INVENTORY_DB_PASSWORD`, `LOG_LEVEL`. The defaults are for a laptop only; change them for anything else.

## Tests and CI

`.github/workflows/ci.yml` runs on every push and pull request to `main`: installs both services, runs their tests (`npm test`) and builds both Docker images.

## Idempotency and consistency

- Inventory keeps one row per order in `reservations` (primary key `order_id`); a redelivered `OrderPlaced` does not reserve stock twice.
- Order's compensation is a no-op when the order is already `CANCELLED`.

## Known limitations (what to change before production)

- No transactional outbox: if the Order service crashes between saving the order and publishing the event, the order stays `PENDING`.
- Inventory does not yet publish a success event, so a reserved order stays `PENDING` (no `CONFIRMED` state yet).
- No Payment service; payment is described in the report only.
- No authentication or API gateway; no idempotency key on `POST /orders`.
- No publisher confirms, dead-letter queue or retry limit; the Inventory consumer re-queues failed messages.
- Health checks are liveness only; no metrics or tracing (structured JSON logs only).
- Single broker node and single database instances; default credentials.
- `tests/` and `contracts/` hold JSON-schema contract tests written for a richer event envelope than the services currently emit; they must be aligned before they can run.
