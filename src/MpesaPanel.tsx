import { useEffect, useRef, useState } from "react";
import { api, ApiError, money, type MpesaRequest, type Sale, type SalePayment } from "./api";

type Props = {
  total: number;
  items: { barcode: string; quantity: number }[];
  getSaleId: () => string;
  onSale: (sale: Sale) => void;
  onClose: () => void;
  onUnauthorized: () => void;
};

export default function MpesaPanel({ total, items, getSaleId, onSale, onClose, onUnauthorized }: Props) {
  // M-Pesa cannot charge cents: whole shillings by M-Pesa, any remainder in cash.
  const mpesaCents = Math.floor(total / 100) * 100;
  const cashCents = total - mpesaCents;

  const [phone, setPhone] = useState("");
  const [request, setRequest] = useState<MpesaRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);

  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) return onUnauthorized();
    setError(err instanceof Error ? err.message : "Something went wrong");
  };

  async function send() {
    setBusy(true);
    setError(null);
    try {
      setRequest((await api.mpesaStk({ sale_id: getSaleId(), phone, amount_cents: mpesaCents })).data);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function check() {
    if (!request) return;
    setBusy(true);
    setError(null);
    try {
      setRequest((await api.mpesaCheck(request.id)).data);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  // Same sale id as the prompt, so a retry can never record the sale twice.
  async function complete() {
    if (!request || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const payments: SalePayment[] = [
        { method: "mpesa", amount_cents: request.amount_cents, mpesa_request_id: request.id },
      ];
      if (cashCents > 0) payments.push({ method: "cash", amount_cents: cashCents, tendered_cents: cashCents });
      const r = await api.createSale({ id: getSaleId(), device_id: "till-1", items, payments });
      onSale(r.data);
    } catch (err) {
      fail(err);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  // Poll while the customer enters their PIN.
  useEffect(() => {
    if (request?.status !== "pending") return;
    const id = request.id;
    const timer = setInterval(() => {
      api.mpesaGet(id).then((r) => setRequest(r.data)).catch(() => {}); // blip: try next tick
    }, 2000);
    return () => clearInterval(timer);
  }, [request?.id, request?.status]);

  // Nothing to collect in cash: record the sale the moment the payment confirms.
  useEffect(() => {
    if (request?.status === "confirmed" && cashCents === 0) void complete();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.status]);

  function cancel() {
    if (request?.status === "pending" && !window.confirm("A prompt is still out. If the customer pays anyway, a manager must reconcile it. Cancel?")) return;
    onClose();
  }

  const status = request?.status;
  return (
    <div className="overlay">
      <div className="panel">
        <h2>Pay with M-Pesa</h2>
        <div className="row bold"><span>Sale total</span><span>{money(total)}</span></div>
        <div className="row"><span>By M-Pesa</span><span>{money(mpesaCents)}</span></div>
        {cashCents > 0 && <div className="row"><span>Cash (M-Pesa has no cents)</span><span>{money(cashCents)}</span></div>}

        {!request && (
          <>
            <input type="tel" inputMode="tel" placeholder="Customer phone, e.g. 0712 345 678" value={phone} onChange={(e) => setPhone(e.target.value)} autoFocus />
            <button className="big mpesa" disabled={busy || !phone.trim()} onClick={send}>
              {busy ? "Sending…" : "Send prompt"}
            </button>
          </>
        )}

        {status === "pending" && (
          <>
            <p className="waiting">Prompt sent to {request!.phone}. Waiting for the customer to enter their PIN…</p>
            <button className="big" disabled={busy} onClick={check}>Customer says they paid: check now</button>
          </>
        )}

        {status === "confirmed" && (
          <>
            <p className="ok">Payment received{request!.receipt_number ? ` · ${request!.receipt_number}` : ""}</p>
            {cashCents > 0 && <p>Collect {money(cashCents)} in cash, then complete the sale.</p>}
            <button className="big primary" disabled={busy} onClick={complete}>
              {busy ? "Saving…" : error ? "Retry saving sale" : "Complete sale"}
            </button>
          </>
        )}

        {(status === "failed" || status === "timed_out") && (
          <>
            <p className="error">
              {status === "timed_out" ? "The customer did not respond in time." : "The payment did not go through."}
              {request!.result_desc ? ` (${request!.result_desc})` : ""}
            </p>
            <button className="big" onClick={() => { setRequest(null); setError(null); }}>Try again</button>
          </>
        )}

        {error && <p className="error">{error}</p>}
        {status !== "confirmed" && <button onClick={cancel}>Cancel</button>}
      </div>
    </div>
  );
}
