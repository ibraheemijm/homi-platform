ALTER TABLE licenses ADD COLUMN activation_request_id TEXT REFERENCES activation_requests(id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_licenses_activation_request
  ON licenses(activation_request_id)
  WHERE activation_request_id IS NOT NULL;
