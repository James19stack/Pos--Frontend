import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, auth, money, type EtimsInvoice, type Product, type Sale, type Shift, type User } from "./api";
import { OpenShift, ShiftPanel } from "./ShiftScreens";
import BackOffice from "./BackOffice";
import MpesaPanel from "./MpesaPanel";
import PaidToTillPanel from "./PaidToTillPanel";

type Line = { product: Product; qty: number };

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(!!auth.get());

  useEffect(() => {
    if (!auth.get()) return;
    api
      .me()
      .then((r) => setUser(r.data))
      .catch(() => auth.clear())
      .finally(() => setChecking(false));
  }, []);

  const logout = () => {
    auth.clear();
    setUser(null);
  };

  if (checking) return <p className="center">Loading…</p>;
  return user ? <ShiftGate user={user} onLogout={logout} /> : <Login onLogin={setUser} />;
}

// Nothing can be sold without an open shift, so the till sits behind this.
function ShiftGate({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [shift, setShift] = useState<Shift | null | undefined>(undefined); // undefined = still loading

  useEffect(() => {
    api
      .currentShift()
      .then((r) => setShift(r.data))
      .catch((e) => (e instanceof ApiError && e.status === 401 ? onLogout() : setShift(null)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (shift === undefined) return <p className="center">Loading…</p>;
  if (shift === null) return <OpenShift user={user} onOpened={setShift} onLogout={onLogout} />;
  return <Till user={user} shift={shift} onLogout={onLogout} onShiftClosed={() => setShift(null)} />;
}

function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.login(email, password);
      auth.set(r.data.token);
      onLogin(r.data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="login" onSubmit={submit}>
      <h1>POS Till</h1>
      <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
      <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      {error && <p className="error">{error}</p>}
      <button className="big primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}

function Till({
  user,
  shift,
  onLogout,
  onShiftClosed,
}: {
  user: User;
  shift: Shift;
  onLogout: () => void;
  onShiftClosed: () => void;
}) {
  const [catalog, setCatalog] = useState<Product[]>([]);
  const [cart, setCart] = useState<Line[]>([]);
  const [code, setCode] = useState("");
  const [tendered, setTendered] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<Sale | null>(null);
  const [mpesaOpen, setMpesaOpen] = useState(false);
  const [tillOpen, setTillOpen] = useState(false);
  const [shiftOpen, setShiftOpen] = useState(false);
  const [backOpen, setBackOpen] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);
  // One id per sale attempt: a retry after a network failure reuses it, so the
  // server returns the original sale instead of recording a duplicate.
  const saleId = useRef<string | null>(null);

  useEffect(() => {
    api.catalog().then((r) => setCatalog(r.data)).catch((e) => setError(e.message));
  }, []);

  useEffect(() => scanRef.current?.focus(), [receipt, cart.length]);

  const byBarcode = useMemo(() => {
    const m = new Map<string, Product>();
    catalog.forEach((p) => p.barcodes.forEach((b) => m.set(b, p)));
    return m;
  }, [catalog]);

  const total = cart.reduce((s, l) => s + Math.round(l.product.price_cents * l.qty), 0);
  const tenderedCents = tendered === "" ? total : Math.round(parseFloat(tendered) * 100);
  const change = Math.max(tenderedCents - total, 0);
  const canPay = cart.length > 0 && !busy && Number.isFinite(tenderedCents) && tenderedCents >= total;

  // Any change to the cart starts a new sale attempt.
  function changeCart(fn: (c: Line[]) => Line[]) {
    if (mpesaOpen || tillOpen) return; // the cart is frozen while a payment prompt is out
    saleId.current = null;
    setCart(fn);
  }

  function scan(e: FormEvent) {
    e.preventDefault();
    const value = code.trim();
    setCode("");
    if (!value) return;
    const p = byBarcode.get(value);
    if (!p) return setError(`Unknown barcode: ${value}`);
    setError(null);
    changeCart((c) => {
      const i = c.findIndex((l) => l.product.id === p.id);
      if (i < 0) return [...c, { product: p, qty: 1 }];
      if (p.is_weighed) return c; // edit the weight on the line instead
      return c.map((l, j) => (j === i ? { ...l, qty: l.qty + 1 } : l));
    });
  }

  const setQty = (id: string, qty: number) =>
    changeCart((c) =>
      qty > 0 ? c.map((l) => (l.product.id === id ? { ...l, qty } : l)) : c.filter((l) => l.product.id !== id)
    );

  async function pay() {
    setBusy(true);
    setError(null);
    if (!saleId.current) saleId.current = crypto.randomUUID();
    try {
      const r = await api.createSale({
        id: saleId.current,
        device_id: "till-1",
        items: cart.map((l) => ({ barcode: l.product.barcodes[0], quantity: l.qty })),
        payments: [{ method: "cash", amount_cents: total, tendered_cents: tenderedCents }],
      });
      setReceipt(r.data);
      setCart([]);
      setTendered("");
      saleId.current = null;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onLogout();
      setError(err instanceof Error ? err.message : "Sale failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="till screen-only">
        <header>
          <strong>POS Till</strong>
          <span>{user.name} ({user.role}) · {catalog.length} products</span>
          <button onClick={() => setShiftOpen(true)}>Shift</button>
          {user.role !== "cashier" && <button onClick={() => setBackOpen(true)}>Back office</button>}
          <button onClick={onLogout}>Sign out</button>
        </header>

        <main>
          <section className="left">
            <form onSubmit={scan}>
              <input
                ref={scanRef}
                className="scan"
                placeholder="Scan or type barcode, then Enter"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="off"
              />
            </form>
            {error && <p className="error">{error}</p>}

            <ul className="cart">
              {cart.length === 0 && <li className="empty">Cart is empty</li>}
              {cart.map((l) => (
                <li key={l.product.id}>
                  <div className="name">
                    {l.product.name}
                    <small>{money(l.product.price_cents)}{l.product.is_weighed ? " / kg" : ""}</small>
                  </div>
                  {l.product.is_weighed ? (
                    <input
                      className="qty"
                      type="number"
                      step="0.001"
                      min="0.001"
                      value={l.qty}
                      onChange={(e) => setQty(l.product.id, parseFloat(e.target.value) || 0.001)}
                    />
                  ) : (
                    <div className="stepper">
                      <button onClick={() => setQty(l.product.id, l.qty - 1)}>−</button>
                      <span>{l.qty}</span>
                      <button onClick={() => setQty(l.product.id, l.qty + 1)}>+</button>
                    </div>
                  )}
                  <div className="line-total">{money(Math.round(l.product.price_cents * l.qty))}</div>
                  <button className="remove" onClick={() => setQty(l.product.id, 0)}>✕</button>
                </li>
              ))}
            </ul>
          </section>

          <aside className="right">
            <div className="total">
              <span>Total</span>
              <strong>{money(total)}</strong>
            </div>
            <label>
              Cash tendered (KES)
              <input
                type="number"
                min="0"
                step="1"
                placeholder={(total / 100).toFixed(2)}
                value={tendered}
                onChange={(e) => setTendered(e.target.value)}
              />
            </label>
            <div className="quick">
              <button onClick={() => setTendered("")}>Exact</button>
              {[500, 1000, 2000].map((n) => (
                <button key={n} onClick={() => setTendered(String(n))}>{n}</button>
              ))}
            </div>
            <div className="change"><span>Change</span><strong>{money(change)}</strong></div>
            <button className="big primary" disabled={!canPay} onClick={pay}>
              {busy ? "Saving…" : "Pay cash"}
            </button>
            <button className="big mpesa" disabled={cart.length === 0 || total < 100 || busy} onClick={() => setMpesaOpen(true)}>
              Pay with M-Pesa
            </button>
            <button className="big" disabled={cart.length === 0 || busy} onClick={() => setTillOpen(true)}>
              Customer already paid to till
            </button>
            <button className="big" disabled={cart.length === 0} onClick={() => changeCart(() => [])}>
              Clear cart
            </button>
          </aside>
        </main>
      </div>

      {mpesaOpen && (
        <MpesaPanel
          total={total}
          items={cart.map((l) => ({ barcode: l.product.barcodes[0], quantity: l.qty }))}
          getSaleId={() => {
            if (!saleId.current) saleId.current = crypto.randomUUID();
            return saleId.current;
          }}
          onSale={(sale) => {
            setReceipt(sale);
            setCart([]);
            setTendered("");
            saleId.current = null;
            setMpesaOpen(false);
          }}
          onClose={() => setMpesaOpen(false)}
          onUnauthorized={onLogout}
        />
      )}
      {backOpen && <BackOffice user={user} onClose={() => setBackOpen(false)} />}
      {shiftOpen && <ShiftPanel shift={shift} onClose={() => setShiftOpen(false)} onClosed={onShiftClosed} />}
      {tillOpen && (
        <PaidToTillPanel
          total={total}
          items={cart.map((l) => ({ barcode: l.product.barcodes[0], quantity: l.qty }))}
          getSaleId={() => {
            if (!saleId.current) saleId.current = crypto.randomUUID();
            return saleId.current;
          }}
          onSale={(sale) => {
            setReceipt(sale);
            setCart([]);
            setTendered("");
            saleId.current = null;
            setTillOpen(false);
          }}
          onClose={() => setTillOpen(false)}
          onUnauthorized={onLogout}
        />
      )}
      {receipt && <Receipt sale={receipt} onClose={() => setReceipt(null)} />}
    </>
  );
}

function Receipt({ sale, onClose }: { sale: Sale; onClose: () => void }) {
  const etims = useEtims(sale.id);
  return (
    <div className="overlay">
      <div className="receipt">
        <h2>Supermarket</h2>
        <p>{sale.receipt_no} · {new Date(sale.sold_at).toLocaleString("en-KE")}</p>
        <hr />
        {sale.items.map((i, k) => (
          <div className="row" key={k}>
            <span>{i.product_name}<small> {Number(i.quantity)} × {money(i.unit_price_cents)}</small></span>
            <span>{money(i.line_total_cents)}</span>
          </div>
        ))}
        <hr />
        <div className="row bold"><span>TOTAL</span><span>{money(sale.total_cents)}</span></div>
        <div className="row"><span>VAT included</span><span>{money(sale.vat_cents)}</span></div>
        {sale.payments.map((p, k) => (
          <div className="row" key={k}>
            <span>
              {({ mpesa: "M-Pesa", cash: "Cash", card: "Card" } as Record<string, string>)[p.method] ?? p.method}
              {p.reference && <small> {p.reference}</small>}
            </span>
            <span>{money(p.tendered_cents ?? p.amount_cents)}</span>
          </div>
        ))}
        {sale.change_due_cents > 0 && (
          <div className="row"><span>Change</span><span>{money(sale.change_due_cents)}</span></div>
        )}
        <EtimsBlock invoice={etims} />
        {sale.needs_review && <p className="note">Stock flagged for manager review</p>}
        <div className="actions no-print">
          <button className="big" onClick={() => window.print()}>Print</button>
          <button className="big primary" onClick={onClose}>New sale</button>
        </div>
      </div>
    </div>
  );
}

// The KRA invoice is filed by a background job a moment after the sale, so check a few times.
function useEtims(saleId: string) {
  const [invoice, setInvoice] = useState<EtimsInvoice | null>(null);

  useEffect(() => {
    let stop = false;
    let tries = 0;
    const tick = async () => {
      try {
        const r = await api.saleEtims(saleId);
        if (stop) return;
        setInvoice(r.data);
        if (r.data.status === "accepted") return;
      } catch (e) {
        // 404: eTIMS is off, so there is no invoice to wait for
        if (e instanceof ApiError && e.status === 404) return;
      }
      if (!stop && ++tries < 10) setTimeout(tick, 1500);
    };
    tick();
    return () => {
      stop = true;
    };
  }, [saleId]);

  return invoice;
}

function EtimsBlock({ invoice }: { invoice: EtimsInvoice | null }) {
  if (!invoice) return null;
  if (invoice.status !== "accepted") {
    return <p className="note">Tax invoice no. {invoice.invoice_no} is being filed with KRA…</p>;
  }
  const t = invoice.sdc_datetime?.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  return (
    <>
      <hr />
      {invoice.mock && <p className="note"><strong>TEST MODE: not a valid tax invoice</strong></p>}
      <div className="row"><span>KRA receipt no.</span><span>{invoice.receipt_no}</span></div>
      <div className="row"><span>Signature</span><span>{invoice.receipt_signature}</span></div>
      <div className="row"><span>Internal data</span><span style={{ wordBreak: "break-all" }}>{invoice.internal_data}</span></div>
      {t && <div className="row"><span>Control unit time</span><span>{`${t[1]}-${t[2]}-${t[3]} ${t[4]}:${t[5]}:${t[6]}`}</span></div>}
    </>
  );
}
