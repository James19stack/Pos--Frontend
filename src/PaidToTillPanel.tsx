import { useState } from "react";
import { api, ApiError, money, type C2BPayment, type Sale, type SalePayment } from "./api";

type Props = {
  total: number;
  items: { barcode: string; quantity: number }[];
  getSaleId: () => string;
  onSale: (sale: Sale) => void;
  onClose: () => void;
  onUnauthorized: () => void;
};

// The customer paid the till/paybill themselves. The code from their SMS is looked up in
// what Safaricom told us, so a code that is not there (a fake SMS) cannot pay for anything.
export default function PaidToTillPanel({ total, items, getSaleId, onSale, onClose, onUnauthorized }: Props) {
  const [code, setCode] = useState("");
  const [payment, setPayment] = useState<C2BPayment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) return onUnauthorized();
    setError(err instanceof Error ? err.message : "Something went wrong");
  };

  async function lookup() {
    setBusy(true);
    setError(null);
    setPayment(null);
    try {
      setPayment((await api.mpesaPayment(code.trim())).data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setError("Not received yet. Check the code, or wait a few seconds and look again.");
      } else {
        fail(err);
      }
    } finally {
      setBusy(false);
    }
  }

  const remainder = payment ? total - payment.amount_cents : 0;
  const problem = !payment
    ? null
    : payment.claimed
    ? "This payment was already used for another sale."
    : remainder < 0
    ? `The customer paid ${money(-remainder)} more than this sale. Refund the difference first, or ask a manager.`
    : null;

  async function complete() {
    if (!payment) return;
    setBusy(true);
    setError(null);
    try {
      const payments: SalePayment[] = [
        { method: "mpesa", amount_cents: payment.amount_cents, mpesa_trans_id: payment.trans_id },
      ];
      if (remainder > 0) payments.push({ method: "cash", amount_cents: remainder, tendered_cents: remainder });
      const r = await api.createSale({ id: getSaleId(), device_id: "till-1", items, payments });
      onSale(r.data);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay">
      <div className="panel">
        <h2>Customer already paid</h2>
        <div className="row bold"><span>Sale total</span><span>{money(total)}</span></div>

        <input
          placeholder="Code from the customer's M-Pesa SMS"
          value={code}
          onChange={(e) => { setCode(e.target.value.toUpperCase()); setPayment(null); }}
          onKeyDown={(e) => e.key === "Enter" && code.trim() && !busy && lookup()}
          autoFocus
        />
        <button className="big mpesa" disabled={busy || !code.trim()} onClick={lookup}>
          {busy && !payment ? "Looking up…" : "Look up payment"}
        </button>

        {payment && (
          <>
            <p className="ok">
              Received {money(payment.amount_cents)}
              {payment.payer_name ? ` from ${payment.payer_name}` : ""}. Confirm the name with the customer.
            </p>
            {remainder > 0 && !problem && <p>Collect {money(remainder)} more in cash, then complete the sale.</p>}
            {problem && <p className="error">{problem}</p>}
            <button className="big primary" disabled={busy || !!problem} onClick={complete}>
              {busy ? "Saving…" : "Complete sale"}
            </button>
          </>
        )}

        {error && <p className="error">{error}</p>}
        <button onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
