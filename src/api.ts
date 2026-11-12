export type User = { id: string; name: string; email: string; role: string };

export type EtimsInvoice = {
  invoice_no: number;
  status: "pending" | "accepted";
  receipt_no: number | null;
  internal_data: string | null;
  receipt_signature: string | null;
  sdc_datetime: string | null; // yyyyMMddHHmmss, East Africa Time
  mock: boolean; // true while a stand-in answers instead of KRA
};

export type AdminProduct = {
  id: string; sku: string; name: string; price_cents: number; cost_cents: number; vat_code: string;
  unit: string; is_weighed: boolean; active: boolean; reorder_level: string; barcodes: string[]; stock_quantity: string | null;
};

export type ShiftReport = {
  shift: { id: string; device_id: string; status: string; opened_at: string; closed_at: string | null };
  sales_count: number;
  total_sales_cents: number;
  vat_cents: number;
  needs_review_count: number;
  by_payment_method: { method: string; count: number; amount_cents: number }[];
  vat_by_code: { vat_code: string; vat_rate_bp: number; gross_cents: number; vat_cents: number }[];
  // Cashiers do not get the expected figures while the shift is open (blind count)
  cash: {
    opening_float_cents: number;
    cash_sales_cents?: number;
    expected_cash_cents?: number;
    counted_cash_cents?: number;
    difference_cents?: number;
  };
};

export type Shift = {
  id: string;
  status: "open" | "pending_approval" | "closed";
  device_id: string;
  opening_float_cents: number;
  opened_at: string;
  closed_at: string | null;
  counted_cash_cents: number | null;
  expected_cash_cents: number | null;
  difference_cents: number | null;
  z_report: ShiftReport | null;
};

export type Product = {
  id: string;
  sku: string;
  name: string;
  price_cents: number;
  is_weighed: boolean;
  unit: string;
  vat_code: string;
  vat_rate_bp: number;
  barcodes: string[];
};

export type SaleItem = {
  product_name: string;
  quantity: string;
  unit_price_cents: number;
  line_total_cents: number;
};

export type Sale = {
  id: string;
  receipt_no: string;
  sold_at: string;
  total_cents: number;
  vat_cents: number;
  change_due_cents: number;
  needs_review: boolean;
  items: SaleItem[];
  payments: { method: string; amount_cents: number; tendered_cents: number | null; reference: string | null }[];
};

export type SalePayload = {
  id: string;
  device_id: string;
  items: { barcode: string; quantity: number }[];
  payments: SalePayment[];
};

export type SalePayment =
  | { method: "cash"; amount_cents: number; tendered_cents: number }
  | { method: "mpesa"; amount_cents: number; mpesa_request_id: string }
  | { method: "mpesa"; amount_cents: number; mpesa_trans_id: string };

// A payment the customer made straight to the till or paybill
export type C2BPayment = {
  trans_id: string;
  amount_cents: number;
  payer_name: string | null;
  paid_at: string;
  claimed: boolean;
};

export type MpesaRequest = {
  id: string;
  sale_id: string;
  amount_cents: number;
  phone: string;
  status: "pending" | "confirmed" | "failed" | "timed_out";
  receipt_number: string | null;
  result_desc: string | null;
  claimed: boolean;
};

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

const TOKEN_KEY = "pos_token";
export const auth = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = auth.get();
  let res: Response;
  try {
    res = await fetch("/api" + path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
  } catch {
    throw new ApiError(0, "network", "Cannot reach the server");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = body?.error?.message ?? body?.errors?.[0]?.detail ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, body?.error?.code ?? "error", message, body?.error?.details);
  }
  return body as T;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ data: { token: string; user: User } }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  me: () => request<{ data: User }>("/me"),
  catalog: () => request<{ data: Product[] }>("/catalog"),
  createSale: (payload: SalePayload) =>
    request<{ data: Sale }>("/sales", { method: "POST", body: JSON.stringify(payload) }),
  mpesaStk: (body: { sale_id: string; phone: string; amount_cents: number }) =>
    request<{ data: MpesaRequest }>("/mpesa/stk", { method: "POST", body: JSON.stringify(body) }),
  mpesaGet: (id: string) => request<{ data: MpesaRequest }>(`/mpesa/requests/${id}`),
  mpesaPayment: (code: string) => request<{ data: C2BPayment }>(`/mpesa/payments/${encodeURIComponent(code)}`),
  currentShift: () => request<{ data: Shift | null }>("/shifts/current"),
  openShift: (opening_float_cents: number) =>
    request<{ data: Shift }>("/shifts/open", {
      method: "POST",
      body: JSON.stringify({ opening_float_cents, device_id: "till-1" }),
    }),
  shiftReport: () => request<{ data: ShiftReport }>("/shifts/current/report"),
  closeShift: (counted_cash_cents: number) =>
    request<{ data: Shift }>("/shifts/close", { method: "POST", body: JSON.stringify({ counted_cash_cents }) }),
  products: (q: string) => request<{ data: AdminProduct[] }>(`/products?limit=100&q=${encodeURIComponent(q)}`),
  lowStock: () => request<{ data: { product: AdminProduct; quantity: string }[] }>("/stock/low"),
  updatePrice: (id: string, price_cents: number) =>
    request<{ data: AdminProduct }>(`/products/${id}`, { method: "PATCH", body: JSON.stringify({ price_cents }) }),
  importCsv: (csv: string, dry_run: boolean) =>
    request<{ data: { created: number; updated: number } }>("/products/import", { method: "POST", body: JSON.stringify({ csv, dry_run }) }),
  receiveGoods: (body: object) => request<{ data: unknown }>("/stock/receipts", { method: "POST", body: JSON.stringify(body) }),
  adjustStock: (body: object) =>
    request<{ data: { stock_quantity: string } }>("/stock/adjustments", { method: "POST", body: JSON.stringify(body) }),
  saleEtims: (saleId: string) => request<{ data: EtimsInvoice }>(`/sales/${saleId}/etims`),
  mpesaCheck: (id: string) => request<{ data: MpesaRequest }>(`/mpesa/requests/${id}/check`, { method: "POST" }),
};

// Integer cents -> "KES 1,234.50"
export const money = (cents: number) =>
  "KES " + (cents / 100).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });