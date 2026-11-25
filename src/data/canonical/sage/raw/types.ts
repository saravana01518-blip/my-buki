/**
 * Raw shapes returned by Sage Business Cloud Accounting API v3.1.
 * No normalization happens here; this file mirrors the wire payloads.
 */

export interface SageListResponse<T> {
  $total: number;
  $page: number;
  $next: string | null;
  $back: string | null;
  $itemsPerPage: number;
  $items: T[];
}

export interface SageRef {
  id: string;
  displayed_as?: string;
  $path?: string;
}

export interface SageBusiness {
  id: string;
  displayed_as?: string;
  name?: string;
}

export interface SageLedgerAccount {
  id: string;
  displayed_as: string;
  nominal_code?: number | string | null;
  ledger_account_type?: {
    id: string;
    displayed_as?: string;
  } | null;
  updated_at?: string | null;
}

export interface SageContact {
  id: string;
  displayed_as?: string;
  name?: string;
  contact_types?: Array<{
    id: string;
    displayed_as?: string;
  }> | null;
  email?: string | null;
  updated_at?: string | null;
}

export interface SageInvoiceLine {
  id?: string;
  description?: string | null;
  ledger_account?: SageRef | null;
  net_amount?: number | string | null;
  tax_amount?: number | string | null;
  total_amount?: number | string | null;
}

export interface SageInvoice {
  id: string;
  displayed_as?: string;
  invoice_number?: string | null;
  reference?: string | null;
  contact?: SageRef | null;
  date: string;
  due_date?: string | null;
  status?: { id: string; displayed_as?: string } | string | null;
  void_reason?: string | null;
  currency?: { id: string; displayed_as?: string } | string | null;
  total_amount?: number | string | null;
  outstanding_amount?: number | string | null;
  net_amount?: number | string | null;
  tax_amount?: number | string | null;
  invoice_lines?: SageInvoiceLine[] | null;
  updated_at?: string | null;
}

export interface SageBankTransaction {
  id: string;
  displayed_as?: string;
  bank_account?: SageRef | null;
  date: string;
  total_amount?: number | string | null;
  amount?: number | string | null;
  transaction_type?: { id: string; displayed_as?: string } | string | null;
  currency?: { id: string; displayed_as?: string } | string | null;
  reference?: string | null;
  description?: string | null;
  ledger_account?: SageRef | null;
  contact?: SageRef | null;
  transfer_id?: string | null;
  is_duplicate_credit?: boolean;
  updated_at?: string | null;
}

export interface SageOAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  token_type?: string;
  obtained_at?: string;
  business_id?: string;
}
