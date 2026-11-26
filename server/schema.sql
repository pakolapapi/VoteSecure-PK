CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS ballot;

CREATE TABLE IF NOT EXISTS ballot.elections (
  id text PRIMARY KEY,
  seat text NOT NULL,
  cutoff date NOT NULL,
  key_fingerprint text NOT NULL,
  closed_at timestamptz,
  publication jsonb,
  CHECK ((closed_at IS NULL) = (publication IS NULL))
);

-- A reset gives the election a new public ID while retaining its configuration.
ALTER TABLE ballot.elections ADD COLUMN IF NOT EXISTS series_id text;
CREATE UNIQUE INDEX IF NOT EXISTS one_run_per_election_series
  ON ballot.elections (COALESCE(series_id, id));

CREATE TABLE IF NOT EXISTS identity.voters (
  cnic text PRIMARY KEY,
  pin_hash text NOT NULL,
  dob date NOT NULL,
  citizen boolean NOT NULL,
  cnic_issued boolean NOT NULL,
  registered boolean NOT NULL,
  resident boolean NOT NULL,
  legally_eligible boolean NOT NULL,
  seat text NOT NULL
);

ALTER TABLE identity.voters DROP CONSTRAINT IF EXISTS voters_cnic_check;
ALTER TABLE identity.voters ADD CONSTRAINT voters_cnic_check
  CHECK (cnic ~ '^0{11}([0-9][1-9]|[1-9]0)$');

CREATE TABLE IF NOT EXISTS identity.issuances (
  election_id text NOT NULL REFERENCES ballot.elections(id),
  cnic text REFERENCES identity.voters(cnic),
  blinded_message text NOT NULL,
  blinded_signature text NOT NULL
);

ALTER TABLE identity.issuances ADD COLUMN IF NOT EXISTS account_cnic_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS issuance_synthetic_voter_per_election
  ON identity.issuances (election_id, cnic);
ALTER TABLE identity.issuances DROP CONSTRAINT IF EXISTS issuances_pkey;
ALTER TABLE identity.issuances ALTER COLUMN cnic DROP NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'identity.issuances'::regclass AND conname = 'issuance_requires_voter'
  ) THEN
    ALTER TABLE identity.issuances ADD CONSTRAINT issuance_requires_voter
      CHECK (cnic IS NOT NULL OR account_cnic_hash IS NOT NULL);
  END IF;
END;
$$;
CREATE UNIQUE INDEX IF NOT EXISTS issuance_account_per_election
  ON identity.issuances (election_id, account_cnic_hash);

CREATE TABLE IF NOT EXISTS ballot.ballots (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  election_id text NOT NULL REFERENCES ballot.elections(id),
  serial_hash text NOT NULL CHECK (serial_hash ~ '^[a-f0-9]{64}$'),
  receipt text NOT NULL CHECK (receipt ~ '^[a-f0-9]{64}$'),
  ciphertext text NOT NULL CHECK (length(ciphertext) = 512 AND ciphertext ~ '^[a-f0-9]+$'),
  UNIQUE (election_id, serial_hash),
  UNIQUE (election_id, receipt)
);
CREATE INDEX IF NOT EXISTS ballot_order ON ballot.ballots (election_id, sequence);
ALTER TABLE ballot.ballots ADD COLUMN IF NOT EXISTS receipt_code text CHECK (receipt_code ~ '^[A-Z]{6}$');
CREATE UNIQUE INDEX IF NOT EXISTS ballot_receipt_code_per_election
  ON ballot.ballots (election_id, receipt_code);

-- Upgrade existing demo databases too. PostgreSQL limits regex repetition bounds to 255.
ALTER TABLE ballot.ballots DROP CONSTRAINT IF EXISTS ballots_ciphertext_check;
ALTER TABLE ballot.ballots ADD CONSTRAINT ballots_ciphertext_check
  CHECK (length(ciphertext) = 512 AND ciphertext ~ '^[a-f0-9]+$');

CREATE SCHEMA IF NOT EXISTS mobile_accounts;
CREATE TABLE IF NOT EXISTS mobile_accounts.users (
  cnic_hash text PRIMARY KEY,
  mobile_hash text NOT NULL UNIQUE,
  encrypted_name bytea NOT NULL
);
CREATE TABLE IF NOT EXISTS mobile_accounts.sessions (
  token_hash text PRIMARY KEY,
  cnic_hash text NOT NULL REFERENCES mobile_accounts.users(cnic_hash) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS mobile_session_expiry ON mobile_accounts.sessions (expires_at);

CREATE TABLE IF NOT EXISTS mobile_accounts.email_identities (
  email_hash text PRIMARY KEY,
  cnic_hash text NOT NULL UNIQUE REFERENCES mobile_accounts.users(cnic_hash) ON DELETE CASCADE
);
ALTER TABLE mobile_accounts.email_identities ADD COLUMN IF NOT EXISTS password_hash text;
CREATE TABLE IF NOT EXISTS mobile_accounts.email_challenges (
  token_hash text PRIMARY KEY,
  email_hash text NOT NULL,
  cnic_hash text NOT NULL,
  mobile_hash text,
  encrypted_name bytea,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5)
);
CREATE TABLE IF NOT EXISTS mobile_accounts.email_limits (
  bucket text NOT NULL,
  expires_at timestamptz NOT NULL,
  sends integer NOT NULL CHECK (sends > 0),
  PRIMARY KEY (bucket, expires_at)
);
CREATE INDEX IF NOT EXISTS email_challenge_expiry ON mobile_accounts.email_challenges (expires_at);
CREATE INDEX IF NOT EXISTS email_limit_expiry ON mobile_accounts.email_limits (expires_at);
