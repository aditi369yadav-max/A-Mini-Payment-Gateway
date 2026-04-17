# UPI Payment Gateway Simulator

A production-grade UPI/payment gateway backend demonstrating real fintech infrastructure patterns including state machines, idempotency, distributed locking, exponential backoff, webhook delivery, and functional programming principles.

---

## Architecture

```
Client
  │
  ▼
Express API (TypeScript)
  │
  ├── Idempotency Middleware  ──▶  Redis (NX SET, 24hr TTL)
  │
  ├── Payment Routes          ──▶  PaymentService
  │                                     │
  │                           ┌─────────┴──────────┐
  │                           ▼                    ▼
  │                    StateMachine (pure)    TransactionRepo
  │                    (no side effects)      (PostgreSQL)
  │
  └── Webhook Routes   ──▶  WebhookRepo ──▶ WebhookSender
                                              (HMAC signed,
                                              retry worker)
```

**Key design decisions:**

- **Pure domain layer** — `StateMachine.ts` has zero side effects. All state logic is pure functions. Mirrors Haskell/Juspay's FP approach.
- **Infrastructure at the edges** — DB, Redis, HTTP calls only in `infrastructure/`. Business logic never calls them directly.
- **ACID transactions** — every state transition uses `withTransaction()` which wraps `BEGIN/COMMIT/ROLLBACK`.
- **Distributed locking** — Redis `SET NX PX` prevents concurrent processing of the same transaction.
- **Idempotency** — `SET NX` ensures duplicate requests return identical responses.

---

## Tech Stack

| Layer       | Technology                  |
|-------------|-----------------------------|
| Runtime     | Node.js + TypeScript        |
| Framework   | Express.js                  |
| Database    | PostgreSQL 15 (ACID)        |
| Cache/Lock  | Redis 7                     |
| Webhooks    | Axios + HMAC-SHA256 signing |
| FP Module   | Haskell (StateMachine.hs)   |
| Logging     | Winston (structured JSON)   |
| Deployment  | Docker Compose              |

---

## Quick Start

### Prerequisites
- Docker & Docker Compose
- Node.js 18+
- (Optional) GHC for Haskell module

### 1. Clone and Install

```bash
git clone <your-repo>
cd upi-gateway
npm install
```

### 2. Environment Setup

```bash
cp .env.example .env
# Edit .env if needed — defaults work with docker-compose
```

### 3. Start Infrastructure

```bash
docker-compose up -d
# Starts PostgreSQL on :5432 and Redis on :6379
```

### 4. Run Database Migrations

```bash
npm run migrate
```

Expected output:
```
  → Applying 001_initial_schema.sql...
  ✓ 001_initial_schema.sql applied
✅ All migrations applied successfully
```

### 5. Start the Server

```bash
npm run dev
```

Expected output:
```
info: PostgreSQL connection verified
info: Redis connection verified
info: UPI Gateway running { port: 3000, env: 'development' }
```

### 6. Run Tests

```bash
npm run test:flow
```

### 7. (Optional) Run Haskell Module

```bash
cd haskell
ghc -o state_machine StateMachine.hs
./state_machine
```

---

## API Documentation

### Base URL
```
http://localhost:3000/api
```

---

### POST /payments/initiate

Initiates a new payment transaction. **Requires `Idempotency-Key` header.**

**Request:**
```bash
curl -X POST http://localhost:3000/api/payments/initiate \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: unique-key-$(date +%s)" \
  -d '{
    "amount": 500.00,
    "currency": "INR",
    "payerUpiId": "aditi@okaxis",
    "payeeUpiId": "merchant@hdfc",
    "merchantId": "merchant_001",
    "description": "Order #1234"
  }'
```

**Response (201):**
```json
{
  "success": true,
  "transactionId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "INITIATED",
  "amount": 500.00,
  "currency": "INR",
  "simulatedOtp": "847291",
  "message": "OTP sent to payer. Use POST /authenticate to verify.",
  "createdAt": "2025-01-15T10:30:00.000Z"
}
```

**Idempotent retry** (same Idempotency-Key):
```json
// Same response + header:
// X-Idempotency-Replayed: true
```

---

### POST /payments/:id/authenticate

Validates the OTP to authenticate the payer.

**Request:**
```bash
curl -X POST http://localhost:3000/api/payments/550e8400-e29b-41d4-a716-446655440000/authenticate \
  -H "Content-Type: application/json" \
  -d '{"otp": "847291"}'
```

**Response (200):**
```json
{
  "success": true,
  "transactionId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "AUTHENTICATED",
  "authenticatedAt": "2025-01-15T10:30:15.000Z",
  "message": "Authentication successful. Call POST /process to complete payment."
}
```

**Invalid OTP (401):**
```json
{
  "error": "Invalid or expired OTP",
  "code": "INVALID_OTP"
}
```

---

### POST /payments/:id/process

Processes the payment — calls the simulated bank/NPCI.

**Request:**
```bash
curl -X POST http://localhost:3000/api/payments/550e8400-e29b-41d4-a716-446655440000/process
```

**Response — Success (200):**
```json
{
  "success": true,
  "transactionId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "SUCCESS",
  "amount": 500.00,
  "bankReferenceId": "BANK_REF_1705312230_A7BX9K",
  "processedAt": "2025-01-15T10:30:20.000Z",
  "message": "Payment processed successfully."
}
```

**Response — Failed (200):**
```json
{
  "success": true,
  "transactionId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "FAILED",
  "failureReason": "INSUFFICIENT_BALANCE",
  "message": "Payment failed: INSUFFICIENT_BALANCE. Call POST /retry to retry."
}
```

**Concurrent processing attempt (409):**
```json
{
  "error": "Payment is already being processed",
  "code": "DUPLICATE_TRANSACTION"
}
```

---

### POST /payments/:id/reconcile

Marks a successful transaction as reconciled. Terminal state — no further transitions.

```bash
curl -X POST http://localhost:3000/api/payments/550e8400-e29b-41d4-a716-446655440000/reconcile
```

**Response (200):**
```json
{
  "success": true,
  "transactionId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "RECONCILED",
  "reconciledAt": "2025-01-15T10:35:00.000Z",
  "message": "Transaction reconciled. Final state reached."
}
```

---

### POST /payments/:id/retry

Resets a FAILED payment to INITIATED for re-authentication.

```bash
curl -X POST http://localhost:3000/api/payments/550e8400-e29b-41d4-a716-446655440000/retry
```

**Response (200):**
```json
{
  "success": true,
  "transactionId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "INITIATED",
  "retryCount": 1,
  "simulatedOtp": "193847",
  "message": "Retry attempt 1. New OTP issued. Re-authenticate to continue."
}
```

**Max retries exceeded (422):**
```json
{
  "error": "Max retry attempts (3) exceeded",
  "code": "PAYMENT_PROCESSING_FAILED"
}
```

---

### GET /payments/:id

Get current transaction status (Redis-cached).

```bash
curl http://localhost:3000/api/payments/550e8400-e29b-41d4-a716-446655440000
```

---

### GET /payments/:id/audit

Full immutable audit trail of all state transitions.

```bash
curl http://localhost:3000/api/payments/550e8400-e29b-41d4-a716-446655440000/audit
```

**Response:**
```json
{
  "success": true,
  "transactionId": "550e8400...",
  "auditLog": [
    {
      "from_status": null,
      "to_status": "INITIATED",
      "triggered_by": "system",
      "created_at": "2025-01-15T10:30:00Z"
    },
    {
      "from_status": "INITIATED",
      "to_status": "AUTHENTICATED",
      "triggered_by": "user",
      "created_at": "2025-01-15T10:30:15Z"
    },
    {
      "from_status": "AUTHENTICATED",
      "to_status": "PROCESSING",
      "triggered_by": "system",
      "created_at": "2025-01-15T10:30:18Z"
    },
    {
      "from_status": "PROCESSING",
      "to_status": "SUCCESS",
      "triggered_by": "system",
      "metadata": { "bankReferenceId": "BANK_REF_..." },
      "created_at": "2025-01-15T10:30:19Z"
    }
  ]
}
```

---

### POST /webhooks/register

Register a URL to receive payment events.

```bash
curl -X POST http://localhost:3000/api/webhooks/register \
  -H "Content-Type: application/json" \
  -d '{
    "merchantId": "merchant_001",
    "url": "https://your-server.com/webhooks/payments",
    "events": ["PAYMENT_SUCCESS", "PAYMENT_FAILED", "PAYMENT_RECONCILED"]
  }'
```

**Response (201):**
```json
{
  "webhookId": "abc123",
  "secret": "a3f8d2e1b4c7...",
  "message": "Store the secret securely — it will not be shown again.",
  "verification": {
    "header": "X-Gateway-Signature",
    "algorithm": "HMAC-SHA256",
    "format": "sha256=<hex_signature>"
  }
}
```

**Verifying webhook signatures (Node.js):**
```javascript
const crypto = require('crypto');

app.post('/webhooks/payments', (req, res) => {
  const signature = req.headers['x-gateway-signature'];
  const body      = JSON.stringify(req.body);
  const expected  = 'sha256=' + crypto
    .createHmac('sha256', YOUR_WEBHOOK_SECRET)
    .update(body)
    .digest('hex');

  if (signature !== expected) {
    return res.status(401).send('Invalid signature');
  }

  console.log('Event:', req.body.event);
  console.log('Transaction:', req.body.transactionId);
  res.status(200).json({ received: true });
});
```

---

## State Machine

```
          ┌──────────────────────────────────────────┐
          │                                          │
 START ──▶ INITIATED ──▶ AUTHENTICATED ──▶ PROCESSING ──▶ SUCCESS ──▶ RECONCILED (terminal)
              ▲                 │                │
              │                 │                │
              └── FAILED ◀──────┴────────────────┘
              (retry resets       (auth fail or    (bank rejected)
               to INITIATED)       timeout)
```

Invalid transitions return `422 INVALID_TRANSITION`. Terminal state `RECONCILED` returns `422 TERMINAL_STATE`.

---

## Edge Cases Handled

| Scenario | Handling |
|---|---|
| Duplicate payment request | Idempotency key returns cached response |
| Concurrent process calls | Distributed Redis lock (SET NX PX) |
| OTP replay attack | Atomic GET+DEL in Redis (consumed once) |
| Expired OTP | 5-min Redis TTL, transitions to FAILED |
| Invalid state jump | Pure state machine rejects at service layer |
| Max retries exceeded | 422 with clear error message |
| Webhook delivery failure | Exponential backoff, dead-letter after 5 attempts |
| DB transaction failure | Automatic ROLLBACK in `withTransaction()` |
| Server crash mid-payment | PROCESSING state visible in DB for recovery |
| Retry storm | Jitter added to backoff delays |

---

## Functional Programming Highlights

| Pattern | Where |
|---|---|
| Pure state transition functions | `src/domain/StateMachine.ts` |
| Immutable domain types (readonly) | `src/domain/Transaction.ts` |
| Either-style result type | `TransitionResult<T>` in StateMachine |
| Side effects at the edges only | All IO in `infrastructure/` only |
| No mutable shared state | All state in DB/Redis, not in-memory |
| Algebraic Data Types | `haskell/StateMachine.hs` |
| Pattern matching | Haskell `validateTransition` |
| Referential transparency | Pure functions have no hidden inputs |

---

## Project Structure

```
upi-gateway/
├── src/
│   ├── domain/              # Pure logic — zero side effects
│   │   ├── Transaction.ts   # Immutable types
│   │   ├── StateMachine.ts  # Pure state transitions
│   │   └── errors/
│   ├── services/            # Business logic orchestration
│   │   └── PaymentService.ts
│   ├── infrastructure/      # All side effects live here
│   │   ├── db/
│   │   ├── cache/
│   │   └── webhook/
│   ├── api/                 # HTTP layer — thin
│   │   ├── routes/
│   │   └── middleware/
│   └── app.ts
├── haskell/
│   └── StateMachine.hs     # Pure FP state machine in Haskell
├── db/
│   └── migrations/
├── tests/
│   └── fullPaymentFlow.test.ts
└── docker-compose.yml
```
