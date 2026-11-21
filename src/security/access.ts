import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "../types";

export interface AdminActor {
  id: string;
  email: string;
  displayName: string;
  roleKey: string;
}

type AuthResult = { actor: AdminActor; response?: never } | { actor?: never; response: Response };

let cachedJwks: { issuer: string; keys: ReturnType<typeof createRemoteJWKSet> } | null = null;

function deny(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: { "cache-control": "no-store" } });
}

function accessIssuer(env: Env): string | null {
  const value = env.CF_ACCESS_TEAM_DOMAIN?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".cloudflareaccess.com") ||
        url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Cloudflare Access proves identity. D1 RBAC decides what that identity may do.
 * A verified email header is never trusted without validating the Access JWT.
 */
export async function authenticateAdmin(
  request: Request,
  env: Env,
  requiredPermissions: string[] = [],
): Promise<AuthResult> {
  const issuer = accessIssuer(env);
  const audience = env.CF_ACCESS_AUD?.trim();
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!issuer || !audience) {
    return { response: deny(503, "ADMIN_AUTH_NOT_CONFIGURED", "تمكين الدخول الإداري غير مهيأ لهذه البيئة.") };
  }
  if (!token) {
    return { response: deny(401, "ADMIN_AUTH_REQUIRED", "يلزم تسجيل الدخول الإداري.") };
  }

  try {
    if (!cachedJwks || cachedJwks.issuer !== issuer) {
      cachedJwks = {
        issuer,
        keys: createRemoteJWKSet(new URL("/cdn-cgi/access/certs", issuer)),
      };
    }
    const { payload } = await jwtVerify(token, cachedJwks.keys, { issuer, audience });
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    if (!email || email.length > 254) {
      return { response: deny(403, "ADMIN_IDENTITY_INVALID", "هوية المستخدم الإداري غير صالحة.") };
    }

    const admin = await env.DB.prepare(
      `SELECT id, email, display_name, role_key
       FROM admin_users
       WHERE lower(email) = ? AND is_active = 1
       LIMIT 1`
    ).bind(email).first<{ id: string; email: string; display_name: string; role_key: string }>();
    if (!admin) {
      return { response: deny(403, "ADMIN_NOT_REGISTERED", "هذا الحساب غير مسجل ضمن مستخدمي إدارة Homi.") };
    }

    if (requiredPermissions.length > 0) {
      const placeholders = requiredPermissions.map(() => "?").join(",");
      const permissions = await env.DB.prepare(
        `SELECT permission_key FROM admin_role_permissions
         WHERE role_key = ? AND permission_key IN (${placeholders})`
      ).bind(admin.role_key, ...requiredPermissions).all<{ permission_key: string }>();
      const granted = new Set((permissions.results ?? []).map((row) => row.permission_key));
      if (requiredPermissions.some((permission) => !granted.has(permission))) {
        return { response: deny(403, "ADMIN_PERMISSION_DENIED", "لا يملك حساب الإدارة الصلاحية المطلوبة.") };
      }
    }

    return {
      actor: {
        id: admin.id,
        email: admin.email,
        displayName: admin.display_name,
        roleKey: admin.role_key,
      },
    };
  } catch {
    return { response: deny(403, "ADMIN_ACCESS_TOKEN_INVALID", "تعذر التحقق من جلسة Cloudflare Access.") };
  }
}
