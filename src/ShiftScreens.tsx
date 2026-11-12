import { FormEvent, useEffect, useState } from "react";
import { api, ApiError, auth, money, type Shift, type ShiftReport, type User } from "./api";

const METHOD: Record<string, string> = { cash: "Cash", mpesa: "M-Pesa", card: "Card" };
const toCents = (kes: string) => Math.round(parseFloat(kes) * 100);

// Shown when the cashier has no open shift: count the float into the drawer, then enter it.
export function OpenShift({ user, onOpened, onLogout }: { user: User; onOpened: (s: Shift) => void; onLogout: () => void }) {
  const [float, setFloat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const cents = toCents(float || "0");
    if (!Number.isFinite(cents) || cents < 0) return setError("Enter the float as a number, 0 or more");
    setBusy(true);
    setError(null);
    try {
      onOpened((await api.openShift(cents)).data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onLogout();
      setError(err instanceof Error ? err.message : "Could not open the shift");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="login" onSubmit={submit}>
      <h1>Open shift</h1>
      <p>Hello {user.name}. Count the cash float into the drawer and enter it.</p>
      <input type="number" min="0" step="1" placeholder="Opening float (KES), e.g. 5000" value={float} onChange={(e) => setFloat(e.target.value)} autoFocus />
      {error && <p className="error">{error}</p>}
      <button className="big primary" disabled={busy}>{busy ? "Opening…" : "Open shift"}</button>
      <button type="button" onClick={() => { auth.clear(); onLogout(); }}>Sign out</button>
    </form>
  );
}

function ReportBody({ report }: { report: ShiftReport }) {
  const c = report.cash;
  return (
    <>
      <div className="row bold"><span>Sales ({report.sales_count})</span><span>{money(report.total_sales_cents)}</span></div>
      <div className="row"><span>VAT included</span><span>{money(report.vat_cents)}</span></div>
      {report.needs_review_count > 0 && <p className="note">{report.needs_review_count} sale(s) flagged for stock review</p>}
      <hr />
      {report.by_payment_method.map((m) => (
        <div className="row" key={m.method}><span>{METHOD[m.method] ?? m.method} × {m.count}</span><span>{money(m.amount_cents)}</span></div>
      ))}
      <hr />
      {report.vat_by_code.map((v) => (
        <div className="row" key={v.vat_code + v.vat_rate_bp}>
          <span>VAT {v.vat_code} ({v.vat_rate_bp / 100}%)</span>
          <span>{money(v.gross_cents)} / {money(v.vat_cents)}</span>
        </div>
      ))}
      <hr />
      <div className="row"><span>Opening float</span><span>{money(c.opening_float_cents)}</span></div>
      {c.cash_sales_cents !== undefined && <div className="row"><span>Cash sales</span><span>{money(c.cash_sales_cents)}</span></div>}
      {c.expected_cash_cents !== undefined && <div className="row bold"><span>Expected in drawer</span><span>{money(c.expected_cash_cents)}</span></div>}
    </>
  );
}

// X report (live snapshot) and the blind cash-up. Closing shows the Z report.
export function ShiftPanel({ shift, onClose, onClosed }: { shift: Shift; onClose: () => void; onClosed: () => void }) {
  const [report, setReport] = useState<ShiftReport | null>(null);
  const [counted, setCounted] = useState("");
  const [result, setResult] = useState<Shift | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.shiftReport().then((r) => setReport(r.data)).catch((e) => setError(e.message));
  }, []);

  async function closeShift() {
    const cents = toCents(counted);
    if (!Number.isFinite(cents) || cents < 0) return setError("Enter what you counted, as a number");
    if (!window.confirm("Close the shift? You cannot sell until you open a new one.")) return;
    setBusy(true);
    setError(null);
    try {
      setResult((await api.closeShift(cents)).data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not close the shift");
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    const diff = result.difference_cents ?? 0;
    return (
      <div className="overlay">
        <div className="panel receipt">
          <h2>Shift closed</h2>
          {result.z_report && <ReportBody report={result.z_report} />}
          <hr />
          <div className="row"><span>Counted</span><span>{money(result.counted_cash_cents ?? 0)}</span></div>
          <div className="row bold"><span>{diff === 0 ? "Drawer balances" : diff > 0 ? "Over" : "Short"}</span><span>{money(Math.abs(diff))}</span></div>
          {result.status === "pending_approval" && <p className="error">This difference needs a manager's approval before the shift is final.</p>}
          <div className="actions no-print">
            <button className="big" onClick={() => window.print()}>Print Z report</button>
            <button className="big primary" onClick={onClosed}>Done</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="overlay">
      <div className="panel receipt">
        <h2>Shift</h2>
        <p>Open since {new Date(shift.opened_at).toLocaleString("en-KE")} · {shift.device_id}</p>
        {report ? <ReportBody report={report} /> : <p>Loading report…</p>}
        <hr />
        <p><strong>Cash-up.</strong> Count everything in the drawer, float included, and enter the total.</p>
        <input type="number" min="0" step="1" placeholder="Counted cash (KES)" value={counted} onChange={(e) => setCounted(e.target.value)} />
        {error && <p className="error">{error}</p>}
        <div className="actions no-print">
          <button className="big primary" disabled={busy || counted === ""} onClick={closeShift}>{busy ? "Closing…" : "Close shift"}</button>
          <button onClick={onClose}>Back to till</button>
        </div>
      </div>
    </div>
  );
}
