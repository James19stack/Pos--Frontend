import { useEffect, useRef, useState } from "react";
import { api, ApiError, money, type AdminProduct, type User } from "./api";

type Tab = "products" | "import" | "receive" | "wastage";
const errText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");
const cents = (kes: string) => Math.round(parseFloat(kes) * 100);

export default function BackOffice({ user, onClose }: { user: User; onClose: () => void }) {
  const manager = user.role === "manager" || user.role === "admin";
  const [tab, setTab] = useState<Tab>("products");
  const tabs: [Tab, string][] = [["products", "Products"], ["receive", "Receive goods"], ["wastage", "Wastage"]];
  if (manager) tabs.splice(1, 0, ["import", "Import CSV"]);

  return (
    <div className="overlay">
      <div className="bo">
        <div className="tabs">
          {tabs.map(([t, label]) => (
            <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{label}</button>
          ))}
          <button style={{ marginLeft: "auto" }} onClick={onClose}>Close</button>
        </div>
        {tab === "products" && <Products manager={manager} />}
        {tab === "import" && <ImportCsv />}
        {tab === "receive" && <Receive />}
        {tab === "wastage" && <Wastage manager={manager} />}
      </div>
    </div>
  );
}

function Products({ manager }: { manager: boolean }) {
  const [q, setQ] = useState("");
  const [low, setLow] = useState(false);
  const [rows, setRows] = useState<{ p: AdminProduct; qty: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    (low
      ? api.lowStock().then((r) => r.data.map((x) => ({ p: x.product, qty: x.quantity })))
      : api.products(q).then((r) => r.data.map((p) => ({ p, qty: p.stock_quantity ?? "0" })))
    ).then(setRows).catch((e) => setError(errText(e)));

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, low]);

  async function setPrice(p: AdminProduct) {
    const v = window.prompt(`New price for ${p.name} (KES, VAT included)`, String(p.price_cents / 100));
    if (v === null) return;
    if (!(cents(v) >= 0)) return setError("Not a valid price");
    try { await api.updatePrice(p.id, cents(v)); setError(null); load(); } catch (e) { setError(errText(e)); }
  }

  return (
    <>
      <div className="line">
        <input placeholder="Search name, SKU or barcode" value={q} onChange={(e) => setQ(e.target.value)} disabled={low} />
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={low} onChange={(e) => setLow(e.target.checked)} style={{ width: "auto" }} /> Low stock only
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      <table>
        <thead><tr><th>Product</th><th>Barcode</th><th>VAT</th><th>Price</th><th>Stock</th></tr></thead>
        <tbody>
          {rows.map(({ p, qty }) => (
            <tr key={p.id}>
              <td>{p.name}<br /><small>{p.sku}{p.active ? "" : " · retired"}</small></td>
              <td>{p.barcodes[0] ?? "-"}</td>
              <td>{p.vat_code}</td>
              <td>{manager ? <button onClick={() => setPrice(p)}>{money(p.price_cents)}</button> : money(p.price_cents)}</td>
              <td>{qty} {p.unit}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p>No products found.</p>}
    </>
  );
}

function ImportCsv() {
  const [csv, setCsv] = useState("");
  const [file, setFile] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [problems, setProblems] = useState<{ row: number | null; error: string }[]>([]);
  const [busy, setBusy] = useState(false);

  async function run(dry: boolean) {
    setBusy(true); setMsg(null); setProblems([]);
    try {
      const r = (await api.importCsv(csv, dry)).data;
      setMsg(dry ? `File is fine: would create ${r.created} and update ${r.updated}.` : `Imported: created ${r.created}, updated ${r.updated}.`);
    } catch (e) {
      if (e instanceof ApiError && e.code === "import_failed") setProblems(((e.details as { errors?: typeof problems })?.errors) ?? []);
      setMsg(errText(e));
    } finally { setBusy(false); }
  }

  return (
    <>
      <p>Columns: <code>sku, name, price, vat_code</code> (required), then <code>barcode</code> (several with |), <code>cost, weighed, unit, reorder_level, opening_stock</code>. Prices in shillings. Existing SKUs are updated; stock is never changed for them. Any bad row means nothing is saved.</p>
      <input type="file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setCsv(await f.text()); setFile(f.name); setMsg(null); setProblems([]); } }} />
      <div className="line">
        <button disabled={!csv || busy} onClick={() => run(true)}>Check file{file && ` (${file})`}</button>
        <button className="primary" disabled={!csv || busy} onClick={() => run(false)}>Import</button>
      </div>
      {msg && <p className={problems.length ? "error" : "ok"}>{msg}</p>}
      {problems.length > 0 && <table><tbody>{problems.map((p, i) => <tr key={i}><td>Row {p.row ?? "-"}</td><td>{p.error}</td></tr>)}</tbody></table>}
    </>
  );
}

type Row = { barcode: string; qty: string; cost: string };
const blank: Row = { barcode: "", qty: "", cost: "" };

function Receive() {
  const [supplier, setSupplier] = useState("");
  const [ref, setRef] = useState("");
  const [rows, setRows] = useState<Row[]>([{ ...blank }]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // One id per delivery: pressing Post twice, or retrying after a dropped connection, cannot add the stock twice.
  const id = useRef(crypto.randomUUID());

  const set = (i: number, k: keyof Row, v: string) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  async function post() {
    const used = rows.filter((r) => r.barcode.trim());
    if (used.length === 0 || used.some((r) => !(parseFloat(r.qty) > 0))) return setMsg({ ok: false, text: "Every line needs a barcode and a quantity above 0" });
    setBusy(true); setMsg(null);
    try {
      await api.receiveGoods({
        id: id.current, supplier_name: supplier || null, reference: ref || null,
        items: used.map((r) => ({ barcode: r.barcode.trim(), quantity: parseFloat(r.qty), ...(r.cost ? { unit_cost_cents: cents(r.cost) } : {}) })),
      });
      setMsg({ ok: true, text: `Posted ${used.length} line(s). Stock updated.` });
      setRows([{ ...blank }]); setSupplier(""); setRef(""); id.current = crypto.randomUUID();
    } catch (e) { setMsg({ ok: false, text: errText(e) }); } finally { setBusy(false); }
  }

  return (
    <>
      <div className="line">
        <input placeholder="Supplier" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
        <input placeholder="Delivery note / invoice no." value={ref} onChange={(e) => setRef(e.target.value)} />
      </div>
      {rows.map((r, i) => (
        <div className="line" key={i}>
          <input placeholder="Barcode (scan)" value={r.barcode} onChange={(e) => set(i, "barcode", e.target.value)} />
          <input type="number" min="0" step="any" placeholder="Quantity" value={r.qty} onChange={(e) => set(i, "qty", e.target.value)} />
          <input type="number" min="0" step="any" placeholder="Unit cost (KES), optional" value={r.cost} onChange={(e) => set(i, "cost", e.target.value)} />
        </div>
      ))}
      <div className="line">
        <button onClick={() => setRows((rs) => [...rs, { ...blank }])}>+ Add line</button>
        <button className="primary" disabled={busy} onClick={post}>{busy ? "Posting…" : "Post delivery"}</button>
      </div>
      {msg && <p className={msg.ok ? "ok" : "error"}>{msg.text}</p>}
    </>
  );
}

function Wastage({ manager }: { manager: boolean }) {
  const [barcode, setBarcode] = useState("");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("wastage");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true); setMsg(null);
    try {
      const r = await api.adjustStock({ barcode: barcode.trim(), quantity: parseFloat(qty), reason, note });
      setMsg({ ok: true, text: `Recorded. Stock now ${r.data.stock_quantity}.` });
      setBarcode(""); setQty(""); setNote("");
    } catch (e) { setMsg({ ok: false, text: errText(e) }); } finally { setBusy(false); }
  }

  return (
    <>
      <p>Wastage and expiry always remove stock. A correction (+ found, - lost) is for managers. A note is required.</p>
      <div className="line">
        <input placeholder="Barcode (scan)" value={barcode} onChange={(e) => setBarcode(e.target.value)} />
        <input type="number" step="any" placeholder="Quantity" value={qty} onChange={(e) => setQty(e.target.value)} />
        <select value={reason} onChange={(e) => setReason(e.target.value)}>
          <option value="wastage">Wastage</option>
          <option value="expiry">Expired</option>
          {manager && <option value="adjustment">Correction (+/-)</option>}
        </select>
      </div>
      <input placeholder="Note (what happened)" value={note} onChange={(e) => setNote(e.target.value)} />
      <button className="primary" disabled={busy || !barcode.trim() || !qty || !note.trim()} onClick={submit}>{busy ? "Saving…" : "Record"}</button>
      {msg && <p className={msg.ok ? "ok" : "error"}>{msg.text}</p>}
    </>
  );
}
