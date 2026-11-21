CREATE TABLE IF NOT EXISTS payment_submissions (
  id TEXT PRIMARY KEY,
  activation_request_id TEXT NOT NULL REFERENCES activation_requests(id),
  method TEXT NOT NULL CHECK (method IN ('cash', 'bank_transfer', 'other')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'SDG',
  reference_note TEXT,
  proof_object_key TEXT,
  proof_file_name TEXT,
  proof_content_type TEXT,
  proof_size_bytes INTEGER,
  proof_sha256_hex TEXT,
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review', 'confirmed', 'rejected')),
  submitted_at TEXT NOT NULL,
  reviewed_by TEXT REFERENCES admin_users(id),
  reviewed_at TEXT,
  review_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payment_submissions_request
  ON payment_submissions(activation_request_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_submissions_status
  ON payment_submissions(status, submitted_at DESC);

ALTER TABLE payments ADD COLUMN payment_submission_id TEXT REFERENCES payment_submissions(id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_submission_unique
  ON payments(payment_submission_id)
  WHERE payment_submission_id IS NOT NULL;
