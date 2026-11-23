import type { Env } from "../types";

type ObjectOptions = {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
};

type MultipartPart = { partNumber: number; etag: string };
type StorageObject = { body: ReadableStream<Uint8Array> | null };

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

async function hmac(key: Uint8Array, value: string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    "raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(value)));
}

function xmlValue(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? match[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">") : null;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function asBytes(body: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>): Promise<Uint8Array> {
  if (body instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(body));
  if (ArrayBuffer.isView(body)) {
    return Promise.resolve(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  }
  return new Response(body).arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

class BackblazeS3Storage {
  private readonly endpoint: URL;
  private readonly bucket: string;
  private readonly region: string;
  private readonly accessKey: string;
  private readonly secretKey: string;

  constructor(env: Env) {
    this.endpoint = new URL(env.B2_ENDPOINT!);
    this.bucket = env.B2_BUCKET!;
    this.region = env.B2_REGION!;
    this.accessKey = env.B2_ACCESS_KEY_ID!;
    this.secretKey = env.B2_SECRET_ACCESS_KEY!;
    if (this.endpoint.protocol !== "https:" || this.endpoint.pathname !== "/" && this.endpoint.pathname !== "") {
      throw new Error("B2_ENDPOINT must be an HTTPS S3 endpoint without a path.");
    }
  }

  private async request(
    method: string,
    key: string,
    query: Array<[string, string]> = [],
    body?: Uint8Array | string,
    contentType?: string,
    metadata?: Record<string, string>,
  ): Promise<Response> {
    const path = `/${awsEncode(this.bucket)}/${key.split("/").map(awsEncode).join("/")}`;
    const encodedQuery = query
      .map(([name, value]): [string, string] => [awsEncode(name), awsEncode(value)])
      .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)
      .map(([name, value]) => `${name}=${value}`)
      .join("&");
    const url = new URL(`${this.endpoint.origin}${path}${encodedQuery ? `?${encodedQuery}` : ""}`);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = await sha256(body ?? "");
    const headers = new Headers({
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
    });
    if (contentType) headers.set("content-type", contentType);
    for (const [name, value] of Object.entries(metadata ?? {})) {
      if (!/^[a-z0-9-]{1,64}$/i.test(name) || /[\r\n]/.test(value)) {
        throw new Error("Invalid object metadata.");
      }
      headers.set(`x-amz-meta-${name.toLowerCase()}`, value);
    }

    const canonicalHeaderEntries: Array<[string, string]> = [
      ["host", url.host],
      ...Array.from(headers.entries()).map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as [string, string]),
    ];
    canonicalHeaderEntries.sort((a, b) => a[0].localeCompare(b[0]));
    const canonicalHeaders = canonicalHeaderEntries.map(([name, value]) => `${name}:${value}\n`).join("");
    const signedHeaders = canonicalHeaderEntries.map(([name]) => name).join(";");
    const canonicalRequest = [
      method, url.pathname, encodedQuery, canonicalHeaders, signedHeaders, payloadHash,
    ].join("\n");
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256", amzDate, scope, await sha256(canonicalRequest),
    ].join("\n");

    const dateKey = await hmac(new TextEncoder().encode(`AWS4${this.secretKey}`), dateStamp);
    const regionKey = await hmac(dateKey, this.region);
    const serviceKey = await hmac(regionKey, "s3");
    const signingKey = await hmac(serviceKey, "aws4_request");
    const signature = hex(await hmac(signingKey, stringToSign));
    headers.set(
      "authorization",
      `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    );

    const init: RequestInit = { method, headers, redirect: "manual" };
    if (body !== undefined && method !== "GET" && method !== "HEAD" && method !== "DELETE") {
      init.body = typeof body === "string" ? body : body;
    }
    const response = await fetch(url, init);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Backblaze B2 S3 request failed with HTTP ${response.status}.`);
    }
    return response;
  }

  async put(
    key: string,
    body: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>,
    options: ObjectOptions = {},
  ): Promise<void> {
    const bytes = await asBytes(body);
    await this.request("PUT", key, [], bytes, options.httpMetadata?.contentType, options.customMetadata);
  }

  async get(key: string): Promise<StorageObject | null> {
    const response = await this.request("GET", key).catch((error: unknown) => {
      if (error instanceof Error && error.message.includes("HTTP 404")) return null;
      throw error;
    });
    return response ? { body: response.body as ReadableStream<Uint8Array> | null } : null;
  }

  async delete(key: string): Promise<void> {
    await this.request("DELETE", key);
  }

  async createMultipartUpload(key: string, options: ObjectOptions = {}): Promise<{
    uploadId: string;
    abort: () => Promise<void>;
  }> {
    const headers = options.customMetadata ?? {};
    const response = await this.request(
      "POST", key, [["uploads", ""]], undefined, options.httpMetadata?.contentType, headers,
    );
    const xml = await response.text();
    const uploadId = xmlValue(xml, "UploadId");
    if (!uploadId) throw new Error("Backblaze B2 did not return a multipart upload ID.");
    return {
      uploadId,
      abort: () => this.abortMultipartUpload(key, uploadId),
    };
  }

  resumeMultipartUpload(key: string, uploadId: string): {
    uploadPart: (partNumber: number, body: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>) => Promise<{
      partNumber: number; etag: string;
    }>;
    complete: (parts: MultipartPart[]) => Promise<{ size: number }>;
    abort: () => Promise<void>;
  } {
    return {
      uploadPart: async (partNumber, body) => {
        if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
          throw new Error("Invalid multipart part number.");
        }
        const bytes = await asBytes(body);
        const response = await this.request(
          "PUT", key, [["partNumber", String(partNumber)], ["uploadId", uploadId]], bytes,
        );
        const etag = response.headers.get("etag");
        if (!etag) throw new Error("Backblaze B2 did not return a multipart ETag.");
        return { partNumber, etag };
      },
      complete: async (parts) => {
        const xml = `<CompleteMultipartUpload>${parts.map((part) =>
          `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`,
        ).join("")}</CompleteMultipartUpload>`;
        const response = await this.request(
          "POST", key, [["uploadId", uploadId]], xml, "application/xml",
        );
        const result = await response.text();
        if (/<Error[ >]/i.test(result)) throw new Error("Backblaze B2 could not complete the multipart upload.");
        const head = await this.request("HEAD", key);
        return { size: Number(head.headers.get("content-length") ?? "0") };
      },
      abort: () => this.abortMultipartUpload(key, uploadId),
    };
  }

  private async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.request("DELETE", key, [["uploadId", uploadId]]);
  }
}

/** Validate the region-specific HTTPS endpoint before signing any storage request. */
export function getStorage(env: Env): BackblazeS3Storage | null {
  if (!env.B2_ENDPOINT || !env.B2_BUCKET || !env.B2_REGION ||
      !env.B2_ACCESS_KEY_ID || !env.B2_SECRET_ACCESS_KEY) return null;
  try {
    const endpoint = new URL(env.B2_ENDPOINT);
    if (endpoint.protocol !== "https:" ||
        endpoint.hostname !== `s3.${env.B2_REGION}.backblazeb2.com`) return null;
    return new BackblazeS3Storage(env);
  } catch {
    return null;
  }
}

export function isStorageConfigured(env: Env): boolean {
  return getStorage(env) !== null;
}
