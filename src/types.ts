export interface Env {
  DB: D1Database;
  FILES?: R2Bucket;
  APP_ENV: string;
  SUPPORT_PHONE: string;
  PUBLIC_SITE_ORIGIN: string;
  ADMIN_SITE_ORIGIN?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  LICENSE_SIGNING_PRIVATE_KEY_PKCS8_B64?: string;
  LICENSE_SIGNING_KEY_ID?: string;
  LICENSE_SIGNING_PUBLIC_KEY_DER_B64?: string;
  UPDATE_SIGNING_PRIVATE_KEY_PKCS8_B64?: string;
  UPDATE_SIGNING_KEY_ID?: string;
  UPDATE_SIGNING_PUBLIC_KEY_DER_B64?: string;
  ROOT_SIGNING_PRIVATE_KEY_PKCS8_B64?: string;
  ROOT_SIGNING_KEY_ID?: string;
  SIGNING_KEYSET_VERSION?: string;
  SIGNING_KEYSET_ADDITIONAL_KEYS_JSON?: string;
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
