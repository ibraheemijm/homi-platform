import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import { getStorage, isStorageConfigured } from "../src/storage/backblaze";

function storageEnv(): Env {
  return {
    DB: {} as D1Database,
    APP_ENV: "test",
    SUPPORT_PHONE: "+2490904697455",
    PUBLIC_SITE_ORIGIN: "https://homi.example",
    B2_ENDPOINT: "https://s3.us-west-004.backblazeb2.com",
    B2_REGION: "us-west-004",
    B2_BUCKET: "homi-preview-files",
    B2_ACCESS_KEY_ID: "test-key-id",
    B2_SECRET_ACCESS_KEY: "test-secret-key",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Backblaze B2 S3 storage adapter", () => {
  it("requires all endpoint, bucket, region, and credential settings", () => {
    expect(isStorageConfigured({} as Env)).toBe(false);
    expect(isStorageConfigured(storageEnv())).toBe(true);
  });

  it("signs private object requests with AWS Signature V4", async () => {
    const captured = { url: "", headers: new Headers() };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.url = String(input);
      captured.headers = new Headers(init?.headers);
      return new Response(null, { status: 200 });
    });

    const storage = getStorage(storageEnv());
    expect(storage).not.toBeNull();
    await storage!.put("activation-requests/request-1/request.hreq", new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "application/vnd.homi.activation-request+json" },
      customMetadata: { requestId: "request-1" },
    });

    expect(captured.url).toContain("s3.us-west-004.backblazeb2.com/homi-preview-files/activation-requests/");
    expect(captured.headers.get("authorization")).toContain("AWS4-HMAC-SHA256 Credential=test-key-id/");
    expect(capturedHeaders?.get("x-amz-content-sha256")).toMatch(/^[a-f0-9]{64}$/);
    expect(capturedHeaders?.get("x-amz-meta-requestid")).toBe("request-1");
    expect(capturedHeaders?.get("authorization")).not.toContain("test-secret-key");
  });

  it("creates, uploads, and completes an S3 multipart upload", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("uploads=")) {
        return new Response("<InitiateMultipartUploadResult><UploadId>upload-123</UploadId></InitiateMultipartUploadResult>", { status: 200 });
      }
      if (url.includes("partNumber=")) {
        return new Response(null, { status: 200, headers: { etag: '"part-etag"' } });
      }
      if (method === "POST" && url.includes("uploadId=")) {
        return new Response("<CompleteMultipartUploadResult><ETag>complete-etag</ETag></CompleteMultipartUploadResult>", { status: 200 });
      }
      if (method === "HEAD") {
        return new Response(null, { status: 200, headers: { "content-length": "8" } });
      }
      return new Response(null, { status: 200 });
    });

    const storage = getStorage(storageEnv())!;
    const created = await storage.createMultipartUpload("releases/v1/app.apk", {
      httpMetadata: { contentType: "application/vnd.android.package-archive" },
      customMetadata: { releaseId: "release-1" },
    });
    expect(created.uploadId).toBe("upload-123");

    const upload = storage.resumeMultipartUpload("releases/v1/app.apk", created.uploadId);
    const part = await upload.uploadPart(1, new Uint8Array(8));
    expect(part).toEqual({ partNumber: 1, etag: '"part-etag"' });
    await expect(upload.complete([part])).resolves.toEqual({ size: 8 });

    expect(calls.map((call) => call.method)).toEqual(["POST", "PUT", "POST", "HEAD"]);
  });

  it("returns null when an object does not exist", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 404 }));
    const storage = getStorage(storageEnv())!;
    await expect(storage.get("missing.hreq")).resolves.toBeNull();
  });
});
