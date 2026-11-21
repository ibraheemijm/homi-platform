export interface Env {
  DB: D1Database;
  APP_ENV: string;
  SUPPORT_PHONE: string;
  PUBLIC_SITE_ORIGIN: string;
  LICENSE_SIGNING_PRIVATE_KEY_PKCS8_B64?: string;
  LICENSE_SIGNING_KEY_ID?: string;
}

export interface ActivationRequestRow {
  id: string;
  product_id: string;
  platform_key: string;
  architecture_key: string;
  device_label: string;
  public_key_raw_b64url: string;
  key_fingerprint: string;
  challenge: string;
  challenge_expires_at: string;
  proof_verified_at: string | null;
  status: string;
  created_at: string;
}
