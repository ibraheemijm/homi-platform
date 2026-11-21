import { useEffect, useState } from "react";

type Customer = { id:string; display_name:string; phone_e164:string; subscription_count:number; active_device_count:number };
type Subscription = { id:string; product_key:string; product_name:string; plan_key:string; status:string; starts_at:string|null; ends_at:string|null; max_devices:number; active_seats:number };
type Device = { id:string; platform_key:string; architecture_key:string; device_label:string; key_fingerprint:string; status:string; license_status:string|null };
type ActivationRequest = { id:string; status:string; device_label:string; platform_key:string; architecture_key:string };
type Detail = {
  customer:{id:string;display_name:string;phone_e164:string;notes:string|null};
  subscriptions:Subscription[]; devices:Device[];
  payments:Array<{id:string;method:string;amount_minor:number;currency:string;status:string;received_at:string|null;created_at:string}>;
};
type Props = {apiBase:string;onError:(value:string)=>void;onNotice:(value:string)=>void};
const names:Record<string,string>={active:"نشط",suspended:"موقوف",expired:"منتهي",cancelled:"ملغي",pending:"بانتظار التفعيل",revoked:"ملغي نهائيًا",monthly:"شهري",annual:"سنوي",lifetime:"دائم",confirmed:"مؤكد",rejected:"مرفوض"};
async function api<T>(base:string,path:string,init?:RequestInit):Promise<T>{
  if(!base)throw new Error("لم يتم إعداد عنوان API لوحة الإدارة.");
  const response=await fetch(base+"/api/v1"+path,{...init,credentials:"include",headers:{"content-type":"application/json",...(init?.headers??{})}});
  const payload=await response.json().catch(()=>null);
  if(!response.ok)throw new Error(payload?.error?.message||"فشل الطلب (HTTP "+response.status+").");
  return payload as T;
}
export default function CustomerManager({apiBase,onError,onNotice}:Props){
  const [q,setQ]=useState(""); const [items,setItems]=useState<Customer[]>([]);
  const [selected,setSelected]=useState(""); const [detail,setDetail]=useState<Detail|null>(null);
  const [busy,setBusy]=useState(false); const [name,setName]=useState(""); const [phone,setPhone]=useState(""); const [notes,setNotes]=useState("");
  const [seats,setSeats]=useState<Record<string,number>>({}); const [requests,setRequests]=useState<ActivationRequest[]>([]);
  const [assigning,setAssigning]=useState(""); const [requestId,setRequestId]=useState("");
  const load=async()=>{
    setBusy(true);onError("");
    try{const r=await api<{items:Customer[]}>(apiBase,"/admin/customers?q="+encodeURIComponent(q)+"&limit=100");setItems(r.items);}
    catch(e){onError(e instanceof Error?e.message:"تعذر تحميل العملاء.");}finally{setBusy(false);}
  };
  const open=async(id:string)=>{
    setBusy(true);onError("");
    try{const d=await api<Detail>(apiBase,"/admin/customers/"+id);setSelected(id);setDetail(d);setName(d.customer.display_name);setPhone(d.customer.phone_e164);setNotes(d.customer.notes||"");setSeats(Object.fromEntries(d.subscriptions.map(s=>[s.id,s.max_devices])));}
    catch(e){onError(e instanceof Error?e.message:"تعذر تحميل ملف العميل.");}finally{setBusy(false);}
  };
  useEffect(()=>{void load();},[]);
  const run=async(path:string,body?:unknown,method="POST")=>{
    try{await api(apiBase,path,{method,body:body===undefined?undefined:JSON.stringify(body)});onNotice("تم حفظ التغيير وتسجيله في سجل التدقيق.");if(selected)await open(selected);await load();}
    catch(e){onError(e instanceof Error?e.message:"تعذر تنفيذ العملية.");}
  };
  const loadRequests=async(subId:string)=>{
    try{
      const [a,b]=await Promise.all([
        api<{items:ActivationRequest[]}>(apiBase,"/admin/activation-requests?status=proof_verified&limit=100"),
        api<{items:ActivationRequest[]}>(apiBase,"/admin/activation-requests?status=under_review&limit=100")
      ]);
      setRequests([...a.items,...b.items]);setRequestId("");setAssigning(subId);
    }catch(e){onError(e instanceof Error?e.message:"تعذر تحميل طلبات الأجهزة.");}
  };
  return <section className="panel" id="customers">
    <div className="panel-heading"><div><h2>العملاء والاشتراكات والأجهزة</h2><p>إدارة بيانات العملاء وسعة الأجهزة وحالة التراخيص</p></div><button className="button secondary" onClick={()=>void load()} disabled={busy}>تحديث</button></div>
    <div className="filters" style={{justifyContent:"flex-start",marginBottom:18}}>
      <input aria-label="بحث العملاء" placeholder="ابحث بالاسم أو رقم الهاتف" value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")void load();}}/>
      <button className="button primary" onClick={()=>void load()} disabled={busy}>بحث</button>
    </div>
    <div className="table-wrap"><table><thead><tr><th>العميل</th><th>الهاتف</th><th>الاشتراكات</th><th>الأجهزة النشطة</th><th>الملف</th></tr></thead><tbody>
      {items.map(c=><tr key={c.id}><td><strong>{c.display_name}</strong><small className="cell-sub mono">{c.id}</small></td><td dir="ltr">{c.phone_e164}</td><td>{c.subscription_count}</td><td>{c.active_device_count}</td><td><button className="button secondary small" onClick={()=>void open(c.id)}>فتح الملف</button></td></tr>)}
    </tbody></table>{!busy&&items.length===0&&<div className="empty-state">لا توجد نتائج مطابقة.</div>}</div>
    {detail&&<div style={{marginTop:24}}>
      <div className="panel-heading"><div><h2>{detail.customer.display_name}</h2><p>ملف العميل · {detail.customer.id}</p></div><button className="button secondary small" onClick={()=>{setDetail(null);setSelected("");}}>إغلاق</button></div>
      <div className="form-grid">
        <label>اسم العميل<input value={name} onChange={e=>setName(e.target.value)}/></label>
        <label>رقم الهاتف<input dir="ltr" value={phone} onChange={e=>setPhone(e.target.value)}/></label>
        <label className="full-span">ملاحظات الإدارة<input value={notes} onChange={e=>setNotes(e.target.value)}/></label>
      </div>
      <div className="modal-actions"><button className="button primary" onClick={()=>void run("/admin/customers/"+selected,{display_name:name,phone_e164:phone,notes},"PATCH")}>حفظ بيانات العميل</button></div>
      <h3>الاشتراكات</h3>
      {detail.subscriptions.map(s=><article className="stat-card" key={s.id} style={{marginBottom:12}}>
        <div className="panel-heading"><div><strong>{s.product_name} · {names[s.plan_key]||s.plan_key}</strong><small className="cell-sub">{names[s.status]||s.status} · المقاعد المستخدمة {s.active_seats}/{s.max_devices}</small><small className="cell-sub">ينتهي: {s.ends_at?new Date(s.ends_at).toLocaleDateString("ar"):"دائم / غير محدد"}</small></div>
          {s.status==="active"?<button className="button secondary small" onClick={()=>void run("/admin/subscriptions/"+s.id+"/suspend")}>إيقاف الاشتراك</button>:s.status==="suspended"?<button className="button secondary small" onClick={()=>void run("/admin/subscriptions/"+s.id+"/reactivate")}>إعادة التفعيل</button>:null}
        </div>
        <div className="filters" style={{justifyContent:"flex-start"}}><label>عدد المقاعد<input type="number" min={1} max={100} value={seats[s.id]??s.max_devices} onChange={e=>setSeats(v=>({...v,[s.id]:Number(e.target.value)}))}/></label>
          <button className="button secondary small" onClick={()=>void run("/admin/subscriptions/"+s.id,{max_devices:seats[s.id]??s.max_devices},"PATCH")}>حفظ السعة</button>
          <button className="button primary small" onClick={()=>void loadRequests(s.id)}>ربط جهاز إضافي</button>
        </div>
        {assigning===s.id&&<div className="filters" style={{justifyContent:"flex-start",marginTop:10}}>
          <select value={requestId} onChange={e=>setRequestId(e.target.value)}><option value="">اختر طلب جهاز مثبت</option>{requests.map(r=><option key={r.id} value={r.id}>{r.device_label} · {r.platform_key} · {r.id.slice(0,8)}</option>)}</select>
          <button className="button primary small" disabled={!requestId} onClick={()=>void run("/admin/subscriptions/"+s.id+"/assign-device",{activation_request_id:requestId})}>تأكيد الربط</button>
          <button className="button secondary small" onClick={()=>setAssigning("")}>إلغاء</button>
        </div>}
      </article>)}
      <h3>الأجهزة والتراخيص</h3>
      <div className="table-wrap"><table><thead><tr><th>الجهاز</th><th>المنصة</th><th>الحالة</th><th>الترخيص</th><th>الإجراء</th></tr></thead><tbody>
        {detail.devices.map(d=><tr key={d.id}><td><strong>{d.device_label}</strong><small className="cell-sub mono">{d.key_fingerprint.slice(0,16)}…</small></td><td>{d.platform_key} · {d.architecture_key}</td><td>{names[d.status]||d.status}</td><td>{names[d.license_status||""]||d.license_status||"—"}</td><td><div className="row-actions">
          {d.status==="active"&&<button className="button secondary small" onClick={()=>void run("/admin/devices/"+d.id+"/suspend")}>إيقاف</button>}
          {d.status==="suspended"&&<button className="button secondary small" onClick={()=>void run("/admin/devices/"+d.id+"/reactivate")}>إعادة التفعيل</button>}
          {d.status!=="revoked"&&<button className="button secondary small" onClick={()=>{if(window.confirm("إلغاء الجهاز نهائيًا؟ لا يمكن التراجع عن هذا الإجراء."))void run("/admin/devices/"+d.id+"/revoke");}}>إلغاء نهائي</button>}
        </div></td></tr>)}
      </tbody></table></div>
      <h3>سجل المدفوعات</h3><div className="table-wrap"><table><thead><tr><th>التاريخ</th><th>الطريقة</th><th>المبلغ</th><th>الحالة</th></tr></thead><tbody>
        {detail.payments.map(p=><tr key={p.id}><td>{new Date(p.received_at||p.created_at).toLocaleDateString("ar")}</td><td>{p.method}</td><td>{p.amount_minor} {p.currency}</td><td>{names[p.status]||p.status}</td></tr>)}
      </tbody></table></div>
    </div>}
  </section>;
}
