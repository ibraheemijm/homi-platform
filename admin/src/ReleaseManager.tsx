import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";

type Release = {
  id: string;
  product_key: string;
  display_name: string;
  version: string;
  build_number: string;
  channel: "stable" | "beta" | "internal";
  status: "draft" | "published" | "withdrawn";
  release_notes_ar: string | null;
  release_notes_en: string | null;
  published_at: string | null;
  asset_count: number;
  assets_json: string | null;
};

type ReleaseAssetSummary = {
  platform_key: string;
  architecture_key: string;
  file_name: string;
  size_bytes: number;
};

type Props = {
  onError: (message: string) => void;
  onNotice: (message: string) => void;
};

const API_BASE = (import.meta.env.VITE_HOMI_API_BASE_URL || "").replace(/\/$/, "");
const CHUNK_SIZE = 8 * 1024 * 1024;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (!API_BASE) throw new Error("لم يتم إعداد VITE_HOMI_API_BASE_URL.");
  const response = await fetch(`${API_BASE}/api/v1${path}`, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || `فشل الطلب (HTTP ${response.status}).`);
  return payload as T;
}

function uploadPartWithProgress(
  url: string,
  blob: Blob,
  onProgress: (loadedBytes: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.withCredentials = true;
    request.timeout = 180000;
    request.setRequestHeader("content-type", "application/octet-stream");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    };
    request.onload = () => {
      let payload: { error?: { message?: string } } | null = null;
      try {
        payload = JSON.parse(request.responseText) as { error?: { message?: string } };
      } catch {
        payload = null;
      }
      if (request.status >= 200 && request.status < 300) {
        resolve();
      } else {
        reject(new Error(payload?.error?.message || `فشل رفع جزء الملف (HTTP ${request.status}).`));
      }
    };
    request.onerror = () => reject(new Error("تعذر الاتصال بخادم رفع الحزم. تحقق من جلسة دخول الإدارة وإعدادات الاتصال."));
    request.ontimeout = () => reject(new Error("انتهت مهلة رفع جزء الملف. أعد المحاولة بعد التحقق من الاتصال."));
    request.onabort = () => reject(new Error("تم إيقاف رفع الملف قبل اكتماله."));
    request.send(blob);
  });
}

function channelName(channel: Release["channel"]): string {
  return channel === "stable" ? "مستقر" : channel === "beta" ? "تجريبي" : "داخلي";
}

function statusName(status: Release["status"]): string {
  return status === "draft" ? "مسودة" : status === "published" ? "منشور" : "مسحوب";
}

function releaseAssets(release: Release): ReleaseAssetSummary[] {
  try {
    const parsed = JSON.parse(release.assets_json || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) =>
      item && typeof item.platform_key === "string" &&
      typeof item.architecture_key === "string" &&
      typeof item.file_name === "string" &&
      typeof item.size_bytes === "number"
    ) : [];
  } catch {
    return [];
  }
}

function ReleaseUploader({ release, onDone, onError }: {
  release: Release;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [platform, setPlatform] = useState("android");
  const [architecture, setArchitecture] = useState("universal");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [progressPercent, setProgressPercent] = useState<number | null>(null);

  const upload = async (file?: File) => {
    if (!file || busy) return;
    setBusy(true);
    setProgress("جارٍ حساب بصمة الملف...");
    setProgressPercent(null);
    try {
      if (file.size < 1 || file.size > 1024 * 1024 * 1024) {
        throw new Error("حجم الحزمة يجب أن يكون أقل من 1 جيجابايت.");
      }
      const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      const contentType = file.type || (platform === "android"
        ? "application/vnd.android.package-archive" : "application/octet-stream");
      const started = await api<{ upload_session_id: string; chunk_size_bytes: number }>(
        `/admin/releases/${release.id}/uploads`,
        {
          method: "POST",
          body: JSON.stringify({
            platform_key: platform,
            architecture_key: architecture,
            file_name: file.name,
            content_type: contentType,
            size_bytes: file.size,
            sha256_hex: sha256,
          }),
        },
      );
      const chunkSize = started.chunk_size_bytes || CHUNK_SIZE;
      const partCount = Math.ceil(file.size / chunkSize);
      let uploadedBytes = 0;
      setProgressPercent(0);
      for (let partNumber = 1; partNumber <= partCount; partNumber++) {
        const start = (partNumber - 1) * chunkSize;
        const end = Math.min(start + chunkSize, file.size);
        setProgress(`جارٍ رفع الجزء ${partNumber} من ${partCount}...`);
        await uploadPartWithProgress(
          `${API_BASE}/api/v1/admin/release-uploads/${started.upload_session_id}/parts/${partNumber}`,
          file.slice(start, end),
          (loadedBytes) => {
            const totalUploaded = Math.min(file.size, uploadedBytes + loadedBytes);
            const percent = Math.floor((totalUploaded / file.size) * 100);
            setProgressPercent(percent);
          },
        );
        uploadedBytes = end;
        setProgressPercent(Math.floor((uploadedBytes / file.size) * 100));
      }
      setProgress("جارٍ إكمال الملف والتحقق من سلامته...");
      await api(`/admin/release-uploads/${started.upload_session_id}/complete`, {
        method: "POST",
        body: "{}",
      });
      setProgressPercent(100);
      setProgress("اكتمل رفع الحزمة والتحقق من حجمها.");
      onDone();
    } catch (error) {
      const message = error instanceof TypeError
        ? "انقطع الاتصال بخدمة رفع الحزم. تحقق من جلسة دخول الإدارة ثم أعد المحاولة."
        : error instanceof Error ? error.message : "تعذر رفع الحزمة.";
      setProgress("");
      setProgressPercent(null);
      onError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="release-upload">
      <select value={platform} onChange={(event) => {
        setPlatform(event.target.value);
        setArchitecture(event.target.value === "android" ? "universal" : "x64");
      }} disabled={busy} aria-label="منصة الحزمة">
        <option value="android">Android</option>
        <option value="windows">Windows</option>
        <option value="linux">Linux</option>
      </select>
      <input aria-label="المعمارية" value={architecture} maxLength={32} onChange={(event) => setArchitecture(event.target.value)} disabled={busy || platform === "android"} />
      <label className="button secondary file-picker">
        {busy ? "جارٍ الرفع..." : "اختيار حزمة"}
        <input type="file" hidden disabled={busy} onChange={(event) => {
          void upload(event.target.files?.[0]);
          event.currentTarget.value = "";
        }} />
      </label>
      {progress && (
        <div className="upload-progress" role="status">
          <div className="upload-progress-label">
            <span>{progress}</span>
            {progressPercent !== null && <strong>{progressPercent}%</strong>}
          </div>
          {progressPercent !== null && (
            <progress
              className="upload-progress-bar"
              max={100}
              value={progressPercent}
              aria-label="نسبة رفع الحزمة"
            />
          )}
        </div>
      )}
    </div>
  );
}

export default function ReleaseManager({ onError, onNotice }: Props) {
  const [items, setItems] = useState<Release[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState("");
  const [buildNumber, setBuildNumber] = useState("");
  const [channel, setChannel] = useState<Release["channel"]>("stable");
  const [notesAr, setNotesAr] = useState("");
  const [notesEn, setNotesEn] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api<{ items: Release[] }>("/admin/releases?product_key=homi-grocery");
      setItems(result.items);
    } catch (error) {
      onError(error instanceof Error ? error.message : "تعذر تحميل الإصدارات.");
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => { void load(); }, [load]);

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    try {
      await api("/admin/releases", {
        method: "POST",
        body: JSON.stringify({
          product_key: "homi-grocery",
          version,
          build_number: buildNumber,
          channel,
          release_notes_ar: notesAr,
          release_notes_en: notesEn,
        }),
      });
      setVersion("");
      setBuildNumber("");
      setNotesAr("");
      setNotesEn("");
      onNotice("تم إنشاء مسودة الإصدار. أضف حزم الأنظمة قبل نشرها.");
      await load();
    } catch (error) {
      onError(error instanceof Error ? error.message : "تعذر إنشاء الإصدار.");
    } finally {
      setSaving(false);
    }
  };

  const publish = async (release: Release) => {
    setSaving(true);
    try {
      await api(`/admin/releases/${release.id}/publish`, { method: "POST", body: "{}" });
      onNotice(`تم نشر الإصدار ${release.version}.`);
      await load();
    } catch (error) {
      onError(error instanceof Error ? error.message : "تعذر نشر الإصدار.");
    } finally {
      setSaving(false);
    }
  };

  const withdraw = async (release: Release) => {
    if (!window.confirm(`هل تريد سحب الإصدار ${release.version}؟ سيختفي من كتالوج التنزيل العام.`)) return;
    setSaving(true);
    try {
      await api(`/admin/releases/${release.id}/withdraw`, { method: "POST", body: "{}" });
      onNotice("تم سحب الإصدار من كتالوج التنزيل.");
      await load();
    } catch (error) {
      onError(error instanceof Error ? error.message : "تعذر سحب الإصدار.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section id="releases" className="panel release-manager">
      <div className="panel-heading">
        <div><h2>إدارة إصدارات Homi Grocery</h2><p>أنشئ مسودة، ارفع الحزم وراجعها، ثم انشرها في كتالوج الموقع.</p></div>
        <button className="button secondary" onClick={() => void load()} disabled={loading}>تحديث</button>
      </div>
      <form className="release-create-form" onSubmit={create}>
        <label>رقم الإصدار<input required pattern="[0-9]+\.[0-9]+\.[0-9]+([+-][A-Za-z0-9.-]+)?" placeholder="1.0.0" value={version} onChange={(event) => setVersion(event.target.value)} /></label>
        <label>رقم البناء<input required inputMode="numeric" pattern="[0-9]{1,10}" maxLength={10} value={buildNumber} onChange={(event) => setBuildNumber(event.target.value)} placeholder="100" /></label>
        <label>قناة الإصدار<select value={channel} onChange={(event) => setChannel(event.target.value as Release["channel"])}><option value="stable">مستقر</option><option value="beta">تجريبي</option><option value="internal">داخلي</option></select></label>
        <label className="full-span">ملاحظات الإصدار بالعربية<textarea maxLength={4000} value={notesAr} onChange={(event) => setNotesAr(event.target.value)} rows={2} /></label>
        <label className="full-span">Release notes (English)<textarea maxLength={4000} value={notesEn} onChange={(event) => setNotesEn(event.target.value)} rows={2} /></label>
        <button className="button primary" type="submit" disabled={saving}>{saving ? "جارٍ الحفظ..." : "إنشاء مسودة إصدار"}</button>
      </form>
      <div className="release-list-admin">
        {loading ? <div className="empty-state">جارٍ تحميل الإصدارات...</div> : items.length === 0 ? (
          <div className="empty-state">لا توجد إصدارات مسجلة بعد.</div>
        ) : items.map((release) => (
          <article className="release-admin-card" key={release.id}>
            <div className="release-admin-head">
              <div><strong>v{release.version} · Build {release.build_number}</strong><small>{channelName(release.channel)} · {statusName(release.status)}</small></div>
              <span className={`status status-${release.status}`}>{release.asset_count} حزمة</span>
            </div>
            {release.asset_count > 0 && (
              <div className="release-assets-list">
                {releaseAssets(release).map((asset) => (
                  <span className="release-asset-chip" key={asset.platform_key + asset.architecture_key}>
                    {asset.platform_key} · {asset.architecture_key} · {(asset.size_bytes / (1024 * 1024)).toFixed(1)} MB
                  </span>
                ))}
              </div>
            )}
            {release.status === "draft" && (
              <>
                <ReleaseUploader release={release} onDone={() => {
                  onNotice("تم رفع الحزمة وتوقيع بصمتها.");
                  void load();
                }} onError={onError} />
                <div className="release-admin-actions">
                  <button className="button primary small" disabled={saving || release.asset_count < 1} onClick={() => void publish(release)}>نشر الإصدار</button>
                  <small>لا يظهر الإصدار على الموقع قبل النشر.</small>
                </div>
              </>
            )}
            {release.status === "published" && (
              <div className="release-admin-actions">
                <small>نُشر في {release.published_at ? new Date(release.published_at).toLocaleString("ar") : "—"}</small>
                <button className="button secondary small" disabled={saving} onClick={() => void withdraw(release)}>سحب الإصدار</button>
              </div>
            )}
          </article>
        ))}
      </div>
      <p className="release-security-note">يُرفع الملف على أجزاء إلى R2. يوقّع الخادم بيانات الإصدار بمفتاح Ed25519 المحفوظ كـ Worker Secret. لا ترفع مفتاح التوقيع إلى لوحة الإدارة أو المستودع.</p>
    </section>
  );
}
