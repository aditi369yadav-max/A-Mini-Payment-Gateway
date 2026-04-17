-- ============================================================
-- UPI Gateway - Complete Database Schema
-- Run in order: 001 -> 002 -> 003
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- ENUM: Transaction Status
-- Strict enumeration prevents invalid states at DB level too
-- ============================================================
CREATE TYPE transaction_status AS ENUM (
  'INITIATED',
  'AUTHENTICATED',
  'PROCESSING',
  'SUCCESS',
  'FAILED',
  'RECONCILED'
);

-- ============================================================
-- TABLE: transactions
-- Core table — every payment lives here
-- ============================================================
CREATE TABLE IF NOT EXISTS transactions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key   VARCHAR(255) UNIQUE NOT NULL,
  amount            NUMERIC(12, 2) NOT NULL,
  currency          VARCHAR(3) NOT NULL DEFAULT 'INR',
  status            transaction_status NOT NULL DEFAULT 'INITIATED',
  payer_upi_id      VARCHAR(255) NOT NULL,
  payee_upi_id      VARCHAR(255) NOT NULL,
  merchant_id       VARCHAR(255) NOT NULL,
  description       TEXT,
  retry_count       INTEGER NOT NULL DEFAULT 0,
  failure_reason    TEXT,
  metadata          JSONB DEFAULT '{}',
  otp_hash          VARCHAR(255),          -- hashed OTP for auth simulation
  bank_reference_id VARCHAR(255),          -- mock bank txn reference
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  authenticated_at  TIMESTAMPTZ,
  processed_at      TIMESTAMPTZ,
  reconciled_at     TIMESTAMPTZ,

  -- Constraints
  CONSTRAINT amount_positive CHECK (amount > 0),
  CONSTRAINT currency_valid  CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT retry_non_negative CHECK (retry_count >= 0)
);

-- Index for common query patterns
CREATE INDEX idx_transactions_status        ON transactions(status);
CREATE INDEX idx_transactions_merchant      ON transactions(merchant_id);
CREATE INDEX idx_transactions_payer         ON transactions(payer_upi_id);
CREATE INDEX idx_transactions_created_at    ON transactions(created_at DESC);
CREATE INDEX idx_transactions_idempotency   ON transactions(idempotency_key);

-- ============================================================
-- TABLE: transaction_state_audit
-- Immutable audit log — every state change recorded forever
-- This is your forensics trail at Juspay-scale systems
-- ============================================================
CREATE TABLE IF NOT EXISTS transaction_state_audit (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id   UUID NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
  from_status      transaction_status,
  to_status        transaction_status NOT NULL,
  triggered_by     VARCHAR(100) NOT NULL,  -- 'system', 'user', 'retry', 'webhook'
  reason           TEXT,
  metadata         JSONB DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_transaction_id ON transaction_state_audit(transaction_id);
CREATE INDEX idx_audit_created_at     ON transaction_state_audit(created_at DESC);

-- ============================================================
-- TABLE: idempotency_keys
-- Persistent store for idempotency (Redis is primary, this is backup)
-- ============================================================
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key              VARCHAR(255) PRIMARY KEY,
  transaction_id   UUID REFERENCES transactions(id),
  response_body    JSONB NOT NULL,
  http_status      INTEGER NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
);

CREATE INDEX idx_idempotency_expires ON idempotency_keys(expires_at);

-- ============================================================
-- TABLE: webhook_registrations
-- Merchants register URLs to receive payment events
-- ============================================================
CREATE TABLE IF NOT EXISTS webhook_registrations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id      VARCHAR(255) NOT NULL,
  url              TEXT NOT NULL,
  secret           VARCHAR(255) NOT NULL,    -- for HMAC signature
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  events           TEXT[] NOT NULL DEFAULT ARRAY['PAYMENT_SUCCESS','PAYMENT_FAILED','PAYMENT_RECONCILED'],
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhook_merchant ON webhook_registrations(merchant_id);
CREATE INDEX idx_webhook_active   ON webhook_registrations(is_active);

-- ============================================================
-- TABLE: webhook_deliveries
-- Track every webhook send attempt — critical for reliability
-- ============================================================
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id   UUID NOT NULL REFERENCES transactions(id),
  webhook_id       UUID NOT NULL REFERENCES webhook_registrations(id),
  event_type       VARCHAR(100) NOT NULL,
  payload          JSONB NOT NULL,
  status           VARCHAR(50) NOT NULL DEFAULT 'PENDING',  -- PENDING, SUCCESS, FAILED, DEAD
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  last_attempt_at  TIMESTAMPTZ,
  next_retry_at    TIMESTAMPTZ DEFAULT NOW(),
  response_status  INTEGER,
  response_body    TEXT,
  error_message    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhook_deliveries_status       ON webhook_deliveries(status);
CREATE INDEX idx_webhook_deliveries_next_retry   ON webhook_deliveries(next_retry_at) WHERE status = 'PENDING';
CREATE INDEX idx_webhook_deliveries_txn          ON webhook_deliveries(transaction_id);

-- ============================================================
-- TABLE: retry_logs
-- Granular retry history for debugging
-- ============================================================
CREATE TABLE IF NOT EXISTS retry_logs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id   UUID NOT NULL REFERENCES transactions(id),
  attempt_number   INTEGER NOT NULL,
  delay_ms         INTEGER NOT NULL,
  reason           TEXT,
  outcome          VARCHAR(50) NOT NULL,  -- 'SUCCESS', 'FAILED', 'SCHEDULED'
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_retry_logs_txn ON retry_logs(transaction_id);

-- ============================================================
-- FUNCTION: auto-update updated_at timestamps
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER transactions_updated_at
  BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER webhook_registrations_updated_at
  BEFORE UPDATE ON webhook_registrations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER webhook_deliveries_updated_at
  BEFORE UPDATE ON webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
