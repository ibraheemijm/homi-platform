import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import ReleaseManager from "./ReleaseManager";

type AdminUser = { id: string; email: string; displayName: string; roleKey: string };
type ActivationRequest = {
  id: string;
  status: string;
  platform_key: string;
  architecture_key: string;
  device_label: string;
  key_fingerprint: string;
  customer_name_snapshot: string | null;
  customer_phone_snapshot: string | null;
  requested_plan: string | null;
  source: string;
  created_at: string;
  proof_verified_at: string | null;
  payment_submission_id: string | null;
  payment_status: string | null;
  payment_method: string | null;
  payment_amount_minor: number | null;
  payment_currency: string | null;
  has_payment_proof: number | null;
};

type ApprovalForm = {
  customer_name: string;
  customer_phone: string;
  plan_key: "monthly" | "annual" | "lifetime";
  max_devices: number;
  payment_method: "cash" | "bank_transfer" | "other";
  amount_minor: number;
  currency: string;
  received_at: string;
  reference_note: string;
  payment_submission_id: string;
};

const API_BASE = (import.meta.env.VITE_HOMI_API_BASE_URL || "").replace(/\/$/, "");
const statusNames: Record<string, string> = {
  pending_proof: "بانتظار إثبات الجهاز",
  proof_verified: "تم إثبات الجهاز",
  under_review: "قيد المراجعة",
  approved: "تمت الموافقة",
  rejected: "مرفوض",
  cancelled: "ملغي",
  expired: "منتهي",
};
const planNames = { monthly: "شهري — 30 يومًا", annual: "سنوي — 365 يومًا", lifetime: "دائم" };

function localDateTime(): string {
  const date = new Date();
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function initialApproval(request?: ActivationRequest): ApprovalForm {
  return {
    customer_name: request?.customer_name_snapshot || "",
    customer_phone: request?.customer_phone_snapshot || "+249",
    plan_key: (request?.requested_plan === "annual" || request?.requested_plan === "lifetime"
      ? request.requested_plan as ApprovalForm["plan_key"] : "monthly"),
    max_devices: 1,
    payment_method: "cash",
    amount_minor: 0,
    currency: "SDG",
    received_at: localDateTime(),
    reference_note: "",
    payment_submission_id: request?.payment_status === "confirmed" ? request.payment_submission_id || "" : "",
  };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (!API_BASE) throw new Error("لم يتم إعداد VITE_HOMI_API_BASE_URL في بيئة لوحة الإدارة.");
  const response = await fetch(`${API_BASE}/api/v1${path}`, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error?.message || (response.status === 401 || response.status === 403
      ? "تعذر الدخول إلى API الإدارة. تحقق من جلسة Cloudflare Access وصلاحيات الحساب."
      : `فشل الطلب (HTTP ${response.status}).`);
    throw new Error(message);
  }
  return payload as T;
}

function App() {
  const [admin, setAdmin] = useState<AdminUser | null>(null);
  const [items, setItems] = useState<ActivationRequest[]>([]);
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<ActivationRequest | null>(null);
  const [form, setForm] = useState<ApprovalForm>(initialApproval());
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const me = await api<{ admin: AdminUser }>("/admin/me");
      setAdmin(me.admin);
      const query = filter === "all" ? "" : `?status=${encodeURIComponent(filter)}`;
      const result = await api<{ items: ActivationRequest[] }>(`/admin/activation-requests${query}`);
      setItems(result.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "تعذر تحميل بيانات لوحة الإدارة.");
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { void load(); }, [load]);

  const counts = useMemo(() => ({
    total: items.length,
    proof: items.filter((item) => item.status === "proof_verified").length,
    review: items.filter((item) => item.status === "under_review").length,
    approved: items.filter((item) => item.status === "approved").length,
  }), [items]);

  const startApproval = (item: ActivationRequest) => {
    setSelected(item);
    setForm(initialApproval(item));
    setNotice("");
  };

  const markReview = async (item: ActivationRequest) => {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await api(`/admin/activation-requests/${item.id}/review`, { method: "POST", body: "{}" });
      setNotice("تم تحويل الطلب إلى قائمة المراجعة.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "تعذر تحديث حالة الطلب.");
    } finally {
      setSaving(false);
    }
  };

  const confirmPayment = async (item: ActivationRequest) => {
    if (!item.payment_submission_id) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await api(`/admin/payment-submissions/${item.payment_submission_id}/confirm`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setNotice("تم تأكيد استلام إثبات الدفع.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "تعذر تأكيد الدفع.");
    } finally {
      setSaving(false);
    }
  };

  const issueLicense = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const body = {
        ...form,
        payment_submission_id: form.payment_submission_id || undefined,
        received_at: new Date(form.received_at).toISOString(),
      };
      const result = await api<{ license_file: Record<string, unknown> }>(
        `/admin/activation-requests/${selected.id}/approve`,
        { method: "POST", body: JSON.stringify(body) },
      );
      setNotice(`تم إصدار الترخيص بنجاح. رقم الترخيص: ${String(result.license_file.license_id)}`);
      setSelected(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "تعذر إصدار الترخيص.");
    } finally {
      setSaving(false);
    }
  };

  const updateForm = <K extends keyof ApprovalForm,>(key: K, value: ApprovalForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  return (
    <div className="admin-shell">
      <aside className="sidebar">
        <a className="brand" href="#"><span className="brand-mark">H</span><span>Homi <small>ADMIN</small></span></a>
        <div className="side-caption">إدارة المنظومة</div>
        <a className="nav-item active" href="#"><span>▦</span> طلبات التفعيل</a>
        <a className="nav-item" href="#releases"><span>⇧</span> إصدارات التطبيقات</a>
        <div className="side-note">الموقع الإداري محمي عبر Cloudflare Access. صلاحيات العمليات تُحدد من المنصة.</div>
        <div className="sidebar-bottom"><span className="online-dot" /> اتصال لوحة الإدارة</div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div><span className="eyebrow">HOMI PLATFORM</span><h1>مركز إدارة التفعيل</h1></div>
          <div className="admin-profile">
            <span className="avatar">{admin?.displayName?.slice(0, 1) || "م"}</span>
            <span><strong>{admin?.displayName || "جارٍ التحقق..."}</strong><small>{admin?.roleKey || "Cloudflare Access"}</small></span>
            <button className="icon-button" onClick={() => void load()} aria-label="تحديث"><span>↻</span></button>
          </div>
        </header>

        {error && <div className="alert error" role="alert">{error}</div>}
        {notice && <div className="alert success" role="status">{notice}</div>}

        <section className="stat-grid">
          <article className="stat-card"><span>الطلبات المعروضة</span><strong>{counts.total}</strong><small>حسب عامل التصفية الحالي</small></article>
          <article className="stat-card"><span>تم إثبات الجهاز</span><strong>{counts.proof}</strong><small>جاهزة للمراجعة</small></article>
          <article className="stat-card"><span>قيد المراجعة</span><strong>{counts.review}</strong><small>تحتاج قرار الإدارة</small></article>
          <article className="stat-card"><span>تمت الموافقة</span><strong>{counts.approved}</strong><small>تراخيص صادرة</small></article>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <div><h2>طلبات التفعيل</h2><p>طلبات الأجهزة التي أرسلتها تطبيقات Homi</p></div>
            <div className="filters">
              <select value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="تصفية الحالة">
                <option value="all">كل الحالات</option>
                <option value="proof_verified">تم إثبات الجهاز</option>
                <option value="under_review">قيد المراجعة</option>
                <option value="approved">تمت الموافقة</option>
                <option value="rejected">مرفوض</option>
              </select>
              <button className="button secondary" onClick={() => void load()} disabled={loading}>تحديث</button>
            </div>
          </div>

          {loading ? <div className="empty-state">جارٍ تحميل الطلبات...</div> : items.length === 0 ? (
            <div className="empty-state"><span className="empty-icon">⌕</span><strong>لا توجد طلبات في هذه القائمة</strong><p>ستظهر طلبات التفعيل بعد إرسالها من تطبيق Homi.</p></div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>الطلب / العميل</th><th>الجهاز</th><th>بصمة الجهاز</th><th>الحالة</th><th>الدفع</th><th>تاريخ الطلب</th><th>الإجراء</th></tr></thead>
                <tbody>
                  {items.map((item) => <tr key={item.id}>
                    <td><strong>{item.customer_name_snapshot || "عميل جديد"}</strong><small className="cell-sub">{item.customer_phone_snapshot || "لم تُسجل بيانات التواصل بعد"}</small><small className="mono">{item.id}</small></td>
                    <td><strong>{item.device_label}</strong><small className="cell-sub">{item.platform_key} · {item.architecture_key}</small></td>
                    <td><span className="fingerprint" title={item.key_fingerprint}>{item.key_fingerprint.slice(0, 12)}…{item.key_fingerprint.slice(-8)}</span></td>
                    <td><span className={`status status-${item.status}`}>{statusNames[item.status] || item.status}</span></td>
                    <td>
                      {item.payment_status ? <span className={`payment-status payment-${item.payment_status}`}>{item.payment_status === "pending_review" ? "بانتظار تأكيد الدفع" : item.payment_status === "confirmed" ? "تم تأكيد الدفع" : "إثبات مرفوض"}</span> : <span className="muted-cell">لا يوجد إثبات</span>}
                      {item.payment_amount_minor ? <small className="cell-sub">{item.payment_amount_minor} {item.payment_currency || ""}</small> : null}
                    </td>
                    <td><span className="date">{new Date(item.created_at).toLocaleString("ar")}</span></td>
                    <td><div className="row-actions">
                      {item.status === "proof_verified" && <button className="button secondary small" disabled={saving} onClick={() => void markReview(item)}>بدء المراجعة</button>}
                      {item.payment_status === "pending_review" && item.payment_submission_id && <>
                        {item.has_payment_proof === 1 && <a className="button secondary small" href={`${API_BASE}/api/v1/admin/payment-submissions/${item.payment_submission_id}/proof`} target="_blank" rel="noreferrer">عرض الإثبات</a>}
                        <button className="button secondary small" disabled={saving} onClick={() => void confirmPayment(item)}>تأكيد الدفع</button>
                      </>}
                      {(item.status === "proof_verified" || item.status === "under_review") && <button className="button primary small" disabled={saving || (item.payment_status === "pending_review")} onClick={() => startApproval(item)}>موافقة وإصدار</button>}
                      {item.status === "approved" && <span className="done-label">تم الإصدار</span>}
                    </div></td>
                  </tr>)}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <ReleaseManager onError={setError} onNotice={setNotice} />

        <footer className="page-footer"><span>Homi Platform · Admin Console</span><span>البيانات التشغيلية للمتجر لا تنتقل إلى هذه المنصة.</span></footer>
      </main>

      {selected && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setSelected(null); }}>
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="approval-title">
          <div className="modal-head"><div><span className="eyebrow">APPROVE ACTIVATION</span><h2 id="approval-title">مراجعة وإصدار الترخيص</h2><p>سيتم تسجيل الدفع كمدفوع مؤكد وإصدار ملف .hlic لهذا الجهاز.</p></div><button className="icon-button" onClick={() => setSelected(null)} disabled={saving} aria-label="إغلاق">×</button></div>
          <div className="device-summary"><span>رقم الطلب</span><code>{selected.id}</code><span>الجهاز</span><strong>{selected.device_label}</strong>{selected.payment_status === "confirmed" && <><span>الدفع</span><strong>إثبات دفع مؤكد · {selected.payment_amount_minor} {selected.payment_currency}</strong></>}</div>
          <form onSubmit={issueLicense}>
            <div className="form-grid">
              <label>اسم العميل / المتجر<input required minLength={2} maxLength={120} value={form.customer_name} onChange={(e) => updateForm("customer_name", e.target.value)} /></label>
              <label>رقم الهاتف<input required type="tel" dir="ltr" placeholder="+249..." value={form.customer_phone} onChange={(e) => updateForm("customer_phone", e.target.value)} /></label>
              <label>نوع الاشتراك<select value={form.plan_key} onChange={(e) => updateForm("plan_key", e.target.value as ApprovalForm["plan_key"])}>{Object.entries(planNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
              <label>عدد الأجهزة المسموح بها<input required type="number" min={1} max={100} value={form.max_devices} onChange={(e) => updateForm("max_devices", Number(e.target.value))} /></label>
              <label>طريقة الدفع<select disabled={Boolean(form.payment_submission_id)} value={form.payment_method} onChange={(e) => updateForm("payment_method", e.target.value as ApprovalForm["payment_method"])}><option value="cash">نقدًا</option><option value="bank_transfer">تحويل بنكي</option><option value="other">أخرى</option></select></label>
              <label>المبلغ المستلم<input disabled={Boolean(form.payment_submission_id)} required type="number" min={1} step={1} value={form.amount_minor} onChange={(e) => updateForm("amount_minor", Number(e.target.value))} /></label>
              <label>العملة<input disabled={Boolean(form.payment_submission_id)} required maxLength={3} minLength={3} dir="ltr" value={form.currency} onChange={(e) => updateForm("currency", e.target.value.toUpperCase())} /></label>
              <label>تاريخ استلام المبلغ<input disabled={Boolean(form.payment_submission_id)} required type="datetime-local" value={form.received_at} onChange={(e) => updateForm("received_at", e.target.value)} /></label>
              <label className="full-span">مرجع الدفع / ملاحظات<input disabled={Boolean(form.payment_submission_id)} maxLength={500} value={form.reference_note} onChange={(e) => updateForm("reference_note", e.target.value)} /></label>
            </div>
            <div className="payment-warning">بتأكيد العملية، تقر الإدارة أنها استلمت المبلغ الموضح أعلاه. لا يمكن إصدار الترخيص المدفوع دون هذا التأكيد.</div>
            <div className="modal-actions"><button type="button" className="button secondary" onClick={() => setSelected(null)} disabled={saving}>إلغاء</button><button type="submit" className="button primary" disabled={saving}>{saving ? "جارٍ الإصدار..." : "تأكيد الاستلام وإصدار الترخيص"}</button></div>
          </form>
        </section>
      </div>}
    </div>
  );
}

export default App;
