import Database from 'better-sqlite3';
import { format } from 'date-fns';
import type InvoiceNinjaClient from './invoiceNinjaClient.js';
import type { Invoice, Payment, Expense, Client, ClientGroup } from './invoiceNinjaClient.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
  -- Metadata: tracks last successful sync so incremental mode knows its cutoff
  CREATE TABLE IF NOT EXISTS sync_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id          TEXT    PRIMARY KEY,
    client_id   TEXT,
    client_name TEXT,
    number      TEXT,
    amount      REAL    NOT NULL DEFAULT 0,
    balance     REAL    NOT NULL DEFAULT 0,
    date        TEXT,
    is_deleted  INTEGER NOT NULL DEFAULT 0
  );
  -- Filter invoices by date (period queries and AR-at-end-of-period)
  CREATE INDEX IF NOT EXISTS idx_inv_date    ON invoices(date);
  -- Join invoices from client-side (group resolution)
  CREATE INDEX IF NOT EXISTS idx_inv_client  ON invoices(client_id);
  -- Partial index: only rows with outstanding balance — used for AR lookups
  CREATE INDEX IF NOT EXISTS idx_inv_balance ON invoices(balance) WHERE balance > 0;

  CREATE TABLE IF NOT EXISTS payments (
    id                    TEXT    PRIMARY KEY,
    client_id             TEXT,
    client_name           TEXT,
    amount                REAL    NOT NULL DEFAULT 0,
    date                  TEXT,
    transaction_reference TEXT,
    is_deleted            INTEGER NOT NULL DEFAULT 0
  );
  -- Filter payments by date (period queries)
  CREATE INDEX IF NOT EXISTS idx_pay_date   ON payments(date);
  -- Group resolution
  CREATE INDEX IF NOT EXISTS idx_pay_client ON payments(client_id);

  CREATE TABLE IF NOT EXISTS paymentables (
    payment_id TEXT NOT NULL,
    invoice_id TEXT NOT NULL,
    amount     REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (payment_id, invoice_id)
  );
  -- Join paymentables → invoices (aging lookup)
  CREATE INDEX IF NOT EXISTS idx_pmtbl_inv ON paymentables(invoice_id);

  CREATE TABLE IF NOT EXISTS expenses (
    id           TEXT    PRIMARY KEY,
    vendor_id    TEXT,
    category_id  TEXT,
    amount       REAL    NOT NULL DEFAULT 0,
    date         TEXT,
    payment_date TEXT,
    public_notes TEXT,
    is_deleted   INTEGER NOT NULL DEFAULT 0
  );
  -- Filter expenses by date (period queries)
  CREATE INDEX IF NOT EXISTS idx_exp_date         ON expenses(date);
  -- Partial index: unpaid expenses (AP outstanding)
  CREATE INDEX IF NOT EXISTS idx_exp_unpaid       ON expenses(payment_date) WHERE payment_date IS NULL;
  -- Filtering / reporting by vendor and category
  CREATE INDEX IF NOT EXISTS idx_exp_vendor       ON expenses(vendor_id);
  CREATE INDEX IF NOT EXISTS idx_exp_category     ON expenses(category_id);

  CREATE TABLE IF NOT EXISTS clients (
    id                TEXT    PRIMARY KEY,
    name              TEXT,
    group_settings_id TEXT,
    custom_value2     TEXT,
    is_deleted        INTEGER NOT NULL DEFAULT 0
  );
  -- Resolve client → group
  CREATE INDEX IF NOT EXISTS idx_cli_group ON clients(group_settings_id);

  CREATE TABLE IF NOT EXISTS client_contacts (
    id         TEXT    PRIMARY KEY,
    client_id  TEXT    NOT NULL,
    first_name TEXT,
    last_name  TEXT,
    email      TEXT,
    phone      TEXT,
    is_primary INTEGER NOT NULL DEFAULT 0
  );
  -- Look up contacts for a client (e.g. for email/reporting)
  CREATE INDEX IF NOT EXISTS idx_contact_client ON client_contacts(client_id);
  -- Look up by email address
  CREATE INDEX IF NOT EXISTS idx_contact_email  ON client_contacts(email);

  CREATE TABLE IF NOT EXISTS client_groups (
    id   TEXT PRIMARY KEY,
    name TEXT
  );

  CREATE TABLE IF NOT EXISTS vendors (
    id   TEXT PRIMARY KEY,
    name TEXT
  );

  CREATE TABLE IF NOT EXISTS expense_categories (
    id   TEXT PRIMARY KEY,
    name TEXT
  );
`;

// ---------------------------------------------------------------------------
// Internal row types (SQLite result shapes)
// ---------------------------------------------------------------------------

interface InvoiceRow {
  id: string;
  client_id: string | null;
  client_name: string | null;
  number: string | null;
  amount: number;
  balance: number;
  date: string | null;
  is_deleted: number;
}

interface PaymentRow {
  id: string;
  client_id: string | null;
  client_name: string | null;
  amount: number;
  date: string | null;
  transaction_reference: string | null;
  is_deleted: number;
}

interface PaymentableRow {
  payment_id: string;
  invoice_id: string;
  amount: number;
}

interface ExpenseRow {
  id: string;
  vendor_id: string | null;
  category_id: string | null;
  amount: number;
  date: string | null;
  payment_date: string | null;
  public_notes: string | null;
  is_deleted: number;
  vendor_name: string | null;
  category_name: string | null;
}

interface ClientRow {
  id: string;
  name: string | null;
  group_settings_id: string | null;
  custom_value2: string | null;
  is_deleted: number;
}

interface ClientGroupRow {
  id: string;
  name: string | null;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The two synchronisation modes supported by `syncDb`. */
export type SyncMode = 'full' | 'incremental';

/** Metadata stored in the database about the last completed sync. */
export interface SyncMeta {
  /** ISO 8601 timestamp of when the last sync completed. */
  lastSyncAt: string;
  /** Which mode was used for the last sync. */
  lastSyncMode: SyncMode;
}

/** Statistics returned after a successful sync. */
export interface SyncStats {
  invoices:          number;
  payments:          number;
  expenses:          number;
  clients:           number;
  contacts:          number;
  clientGroups:      number;
  vendors:           number;
  expenseCategories: number;
  mode:              SyncMode;
  elapsedMs:         number;
}

/** All data slices required by `buildHoaReportData`. */
export interface DbQueryResult {
  /** Every non-deleted invoice issued on or before `periodEnd`. */
  allInvoices:    Invoice[];
  /** Non-deleted invoices whose date falls within [periodStart, periodEnd]. */
  periodInvoices: Invoice[];
  /** Non-deleted payments received within [periodStart, periodEnd], with `paymentables` populated. */
  periodPayments: Payment[];
  /** Non-deleted expenses whose date falls within [periodStart, periodEnd]. */
  periodExpenses: Expense[];
  /** Every non-deleted expense (for AP outstanding balance). */
  allExpenses:    Expense[];
  /** Every non-deleted client. */
  allClients:     Client[];
  /** Every client group. */
  clientGroups:   ClientGroup[];
}

// ---------------------------------------------------------------------------
// DB lifecycle
// ---------------------------------------------------------------------------

/**
 * Open (or create) the SQLite database and apply the schema.
 *
 * @param dbPath File path for persistent storage (default `'./hoa-cache.db'`).
 *               Pass `':memory:'` for a temporary in-process DB (testing).
 *               Override via the `DB_CACHE_PATH` environment variable.
 */
export function createDb(dbPath = './hoa-cache.db'): InstanceType<typeof Database> {
  const db = new Database(dbPath);
  // WAL mode: concurrent reads, faster writes
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA_SQL);
  // Migrate: add custom_value2 column if it doesn't exist yet (idempotent).
  // Use PRAGMA table_info to check before attempting ALTER TABLE so we never
  // silently swallow unrelated database errors.
  const hasCustomValue2 = (db.prepare(`PRAGMA table_info(clients)`).all() as Array<{ name: string }>)
    .some(col => col.name === 'custom_value2');
  if (!hasCustomValue2) {
    db.exec(`ALTER TABLE clients ADD COLUMN custom_value2 TEXT`);
  }
  // Migrate: add number column to invoices if missing
  const invoiceCols = (db.prepare(`PRAGMA table_info(invoices)`).all() as Array<{ name: string }>)
    .map(c => c.name);
  if (!invoiceCols.includes('number')) {
    db.exec(`ALTER TABLE invoices ADD COLUMN number TEXT`);
  }
  // Migrate: add transaction_reference column to payments if missing
  const paymentCols = (db.prepare(`PRAGMA table_info(payments)`).all() as Array<{ name: string }>)
    .map(c => c.name);
  if (!paymentCols.includes('transaction_reference')) {
    db.exec(`ALTER TABLE payments ADD COLUMN transaction_reference TEXT`);
  }
  // Migrate: add public_notes column to expenses if missing
  const expenseCols = (db.prepare(`PRAGMA table_info(expenses)`).all() as Array<{ name: string }>)
    .map(c => c.name);
  if (!expenseCols.includes('public_notes')) {
    db.exec(`ALTER TABLE expenses ADD COLUMN public_notes TEXT`);
  }
  return db;
}

/** Read the last sync metadata from the database. Returns `null` when no sync has ever run. */
export function getSyncMeta(db: InstanceType<typeof Database>): SyncMeta | null {
  const rows = db.prepare(
    "SELECT key, value FROM sync_meta WHERE key IN ('last_sync_at', 'last_sync_mode')"
  ).all() as Array<{ key: string; value: string }>;

  const map: Record<string, string> = {};
  for (const row of rows) map[row.key] = row.value;

  const lastSyncAt   = map['last_sync_at'];
  const lastSyncMode = map['last_sync_mode'] as SyncMode | undefined;
  if (!lastSyncAt || !lastSyncMode) return null;
  return { lastSyncAt, lastSyncMode };
}

/** Persist sync metadata after a successful sync. */
function saveSyncMeta(db: InstanceType<typeof Database>, meta: SyncMeta): void {
  const stmt = db.prepare("INSERT OR REPLACE INTO sync_meta(key, value) VALUES (?, ?)");
  db.transaction(() => {
    stmt.run('last_sync_at',   meta.lastSyncAt);
    stmt.run('last_sync_mode', meta.lastSyncMode);
  })();
}

/** Truncate all data tables (keeps schema, indexes and sync_meta intact). */
function clearDataTables(db: InstanceType<typeof Database>): void {
  db.transaction(() => {
    db.exec('DELETE FROM invoices');
    db.exec('DELETE FROM payments');
    db.exec('DELETE FROM paymentables');
    db.exec('DELETE FROM expenses');
    db.exec('DELETE FROM clients');
    db.exec('DELETE FROM client_contacts');
    db.exec('DELETE FROM client_groups');
    db.exec('DELETE FROM vendors');
    db.exec('DELETE FROM expense_categories');
  })();
}

// ---------------------------------------------------------------------------
// Sync helpers
// ---------------------------------------------------------------------------

/** Resolve the client display name from a record that may carry it in
 *  different fields depending on whether it was fetched with `include`. */
function resolveClientName(
  record: { client_name?: string; client?: { name: string } }
): string | null {
  return record.client_name ?? record.client?.name ?? null;
}

/** Resolve the canonical date from records that expose it under two
 *  different field names (Invoice Ninja uses both in different contexts). */
function resolveDate(
  record: { date?: string; invoice_date?: string; expense_date?: string; payment_date?: string },
  fallback: 'invoice_date' | 'expense_date' | 'payment_date' | undefined = undefined
): string | null {
  return record.date ?? (fallback ? (record as Record<string, string | undefined>)[fallback] : undefined) ?? null;
}

/**
 * Synchronise the local SQLite database with Invoice Ninja.
 *
 * **Full mode** (`mode = 'full'`): clears all data tables, then fetches the
 * complete dataset from Invoice Ninja (no date or `updated_at` constraints).
 *
 * **Incremental mode** (`mode = 'incremental'`): reads the `last_sync_at`
 * timestamp stored by the previous sync, then uses Invoice Ninja's
 * `updated_at` Unix-timestamp filter to request only records changed since
 * that point. Each entity is upserted (`INSERT OR REPLACE`), so deletions
 * (soft-deleted records) are also picked up when the API returns them.
 *
 * Requires the DB to have been populated at least once in full mode before
 * incremental mode can be used.
 *
 * Data fetched (8 steps):
 *  1. Invoices
 *  2. Payments + Paymentables
 *  3. Expenses
 *  4. Clients + Contacts
 *  5. Client groups
 *  6. Vendors
 *  7. Expense categories
 *  (8) Save sync metadata
 *
 * @param db        Open SQLite database created with `createDb()`.
 * @param client    Invoice Ninja API client.
 * @param mode      `'full'` or `'incremental'`.
 * @param onProgress Callback for human-readable progress messages.
 */
export async function syncDb(
  db: InstanceType<typeof Database>,
  client: InvoiceNinjaClient,
  mode: SyncMode,
  onProgress: (msg: string) => void
): Promise<SyncStats> {
  const t0 = Date.now();

  // ---- Determine updated_at cutoff for incremental mode ----
  let updatedAtFilter: number | undefined;
  if (mode === 'incremental') {
    const meta = getSyncMeta(db);
    if (!meta) {
      throw new Error(
        'No hay datos de sincronización previos. ' +
        'Ejecute "npm start sync full" primero antes de usar el modo incremental.'
      );
    }
    // Convert ISO timestamp → Unix seconds (the Invoice Ninja API expects integer seconds)
    updatedAtFilter = Math.floor(new Date(meta.lastSyncAt).getTime() / 1000);
    onProgress(`🔄 Modo incremental — cambios desde ${meta.lastSyncAt}`);
  } else {
    onProgress(`🗑️  Modo completo — limpiando datos anteriores...`);
    clearDataTables(db);
  }

  const baseFilters = updatedAtFilter !== undefined ? { updated_at: updatedAtFilter } : {};

  // Prepared statements (reused across rows for performance)
  const stmtInvoice = db.prepare(`
    INSERT OR REPLACE INTO invoices(id, client_id, client_name, number, amount, balance, date, is_deleted)
    VALUES (@id, @client_id, @client_name, @number, @amount, @balance, @date, @is_deleted)
  `);
  const stmtPayment = db.prepare(`
    INSERT OR REPLACE INTO payments(id, client_id, client_name, amount, date, transaction_reference, is_deleted)
    VALUES (@id, @client_id, @client_name, @amount, @date, @transaction_reference, @is_deleted)
  `);
  const stmtPaymentable = db.prepare(`
    INSERT OR REPLACE INTO paymentables(payment_id, invoice_id, amount)
    VALUES (@payment_id, @invoice_id, @amount)
  `);
  const deletePaymentables = db.prepare(`DELETE FROM paymentables WHERE payment_id = ?`);
  const stmtExpense = db.prepare(`
    INSERT OR REPLACE INTO expenses(id, vendor_id, category_id, amount, date, payment_date, public_notes, is_deleted)
    VALUES (@id, @vendor_id, @category_id, @amount, @date, @payment_date, @public_notes, @is_deleted)
  `);
  const stmtClient = db.prepare(`
    INSERT OR REPLACE INTO clients(id, name, group_settings_id, custom_value2, is_deleted)
    VALUES (@id, @name, @group_settings_id, @custom_value2, @is_deleted)
  `);
  const stmtContact = db.prepare(`
    INSERT OR REPLACE INTO client_contacts(id, client_id, first_name, last_name, email, phone, is_primary)
    VALUES (@id, @client_id, @first_name, @last_name, @email, @phone, @is_primary)
  `);
  const deleteContacts = db.prepare(`DELETE FROM client_contacts WHERE client_id = ?`);
  const stmtClientGroup = db.prepare(`
    INSERT OR REPLACE INTO client_groups(id, name) VALUES (@id, @name)
  `);
  const stmtVendor = db.prepare(`
    INSERT OR REPLACE INTO vendors(id, name) VALUES (@id, @name)
  `);
  const stmtCategory = db.prepare(`
    INSERT OR REPLACE INTO expense_categories(id, name) VALUES (@id, @name)
  `);

  // Helper: format pagination progress line
  function pageMsg(page: number, totalPages: number | null, fetched: number): string {
    const ofStr = totalPages ? `/${totalPages}` : '';
    return `      → Página ${page}${ofStr} (${fetched} registros acumulados)`;
  }

  // 1/7 — Invoices
  onProgress(`[1/7] Descargando facturas...`);
  const invoices = await client.getInvoices(
    { ...baseFilters },
    (page, total, fetched) => onProgress(pageMsg(page, total, fetched))
  );
  db.transaction(() => {
    for (const inv of invoices) {
      stmtInvoice.run({
        id:          inv.id ?? '',
        client_id:   inv.client_id ?? null,
        client_name: resolveClientName(inv),
        number:      inv.number ?? null,
        amount:      Number(inv.amount) || 0,
        balance:     Number(inv.balance) || 0,
        date:        resolveDate(inv, 'invoice_date'),
        is_deleted:  inv.is_deleted ? 1 : 0,
      });
    }
  })();
  onProgress(`      ✓ ${invoices.length} facturas almacenadas`);

  // 2/7 — Payments (paymentables stored in a separate table)
  onProgress(`[2/7] Descargando pagos...`);
  const payments = await client.getPayments(
    { ...baseFilters },
    (page, total, fetched) => onProgress(pageMsg(page, total, fetched))
  );
  db.transaction(() => {
    for (const p of payments) {
      const pid = p.id ?? '';
      stmtPayment.run({
        id:                    pid,
        client_id:             p.client_id ?? null,
        client_name:           resolveClientName(p),
        amount:                Number(p.amount) || 0,
        date:                  resolveDate(p, 'payment_date'),
        transaction_reference: p.transaction_reference ?? null,
        is_deleted:            p.is_deleted ? 1 : 0,
      });
      // Re-sync paymentables fully for each payment to avoid stale rows
      deletePaymentables.run(pid);
      const linked = p.paymentables ?? p.invoices ?? [];
      for (const pa of linked) {
        if (!pa.invoice_id) continue;
        stmtPaymentable.run({
          payment_id: pid,
          invoice_id: pa.invoice_id,
          amount:     Number(pa.amount) || 0,
        });
      }
    }
  })();
  onProgress(`      ✓ ${payments.length} pagos almacenados`);

  // 3/7 — Expenses
  onProgress(`[3/7] Descargando gastos...`);
  const expenses = await client.getExpenses(
    { ...baseFilters },
    (page, total, fetched) => onProgress(pageMsg(page, total, fetched))
  );
  db.transaction(() => {
    for (const e of expenses) {
      stmtExpense.run({
        id:           e.id ?? '',
        vendor_id:    e.vendor_id ?? null,
        category_id:  e.category_id ?? null,
        amount:       Number(e.amount) || 0,
        date:         resolveDate(e, 'expense_date'),
        payment_date: e.payment_date ?? null,
        public_notes: e.public_notes ?? null,
        is_deleted:   e.is_deleted ? 1 : 0,
      });
    }
  })();
  onProgress(`      ✓ ${expenses.length} gastos almacenados`);

  // 4/7 — Clients + Contacts
  onProgress(`[4/7] Descargando clientes y contactos...`);
  const clientList = await client.getClients(
    { ...baseFilters },
    (page, total, fetched) => onProgress(pageMsg(page, total, fetched))
  );
  let contactCount = 0;
  db.transaction(() => {
    for (const c of clientList) {
      stmtClient.run({
        id:                c.id,
        name:              c.name ?? null,
        group_settings_id: c.group_settings_id ?? null,
        custom_value2:     c.custom_value2 ?? null,
        is_deleted:        c.is_deleted ? 1 : 0,
      });
      // Re-sync contacts for this client (handles additions, removals, updates)
      deleteContacts.run(c.id);
      for (const ct of (c.contacts ?? [])) {
        if (!ct.id) continue;
        stmtContact.run({
          id:         ct.id,
          client_id:  c.id,
          first_name: ct.first_name ?? null,
          last_name:  ct.last_name  ?? null,
          email:      ct.email      ?? null,
          phone:      ct.phone      ?? null,
          is_primary: ct.is_primary ? 1 : 0,
        });
        contactCount++;
      }
    }
  })();
  onProgress(`      ✓ ${clientList.length} clientes, ${contactCount} contactos almacenados`);

  // 5/7 — Client groups
  onProgress(`[5/7] Descargando grupos de clientes...`);
  const clientGroups = await client.getClientGroups(
    { ...baseFilters },
    (page, total, fetched) => onProgress(pageMsg(page, total, fetched))
  );
  db.transaction(() => {
    for (const g of clientGroups) {
      stmtClientGroup.run({ id: g.id, name: g.name ?? null });
    }
  })();
  onProgress(`      ✓ ${clientGroups.length} grupos almacenados`);

  // 6/7 — Vendors
  onProgress(`[6/7] Descargando proveedores...`);
  const vendors = await client.getVendors(
    { ...baseFilters },
    (page, total, fetched) => onProgress(pageMsg(page, total, fetched))
  );
  db.transaction(() => {
    for (const v of vendors) {
      stmtVendor.run({ id: v.id, name: v.name ?? null });
    }
  })();
  onProgress(`      ✓ ${vendors.length} proveedores almacenados`);

  // 7/7 — Expense categories
  onProgress(`[7/7] Descargando categorías de gastos...`);
  const categories = await client.getExpenseCategories(
    { ...baseFilters },
    (page, total, fetched) => onProgress(pageMsg(page, total, fetched))
  );
  db.transaction(() => {
    for (const cat of categories) {
      stmtCategory.run({ id: cat.id, name: cat.name ?? null });
    }
  })();
  onProgress(`      ✓ ${categories.length} categorías almacenadas`);

  // Persist sync metadata
  const completedAt = new Date().toISOString();
  saveSyncMeta(db, { lastSyncAt: completedAt, lastSyncMode: mode });

  const stats: SyncStats = {
    invoices:          invoices.length,
    payments:          payments.length,
    expenses:          expenses.length,
    clients:           clientList.length,
    contacts:          contactCount,
    clientGroups:      clientGroups.length,
    vendors:           vendors.length,
    expenseCategories: categories.length,
    mode,
    elapsedMs:         Date.now() - t0,
  };
  return stats;
}

// ---------------------------------------------------------------------------
// Row → domain object converters
// ---------------------------------------------------------------------------

function rowToInvoice(row: InvoiceRow): Invoice {
  return {
    id:          row.id,
    client_id:   row.client_id  ?? undefined,
    client_name: row.client_name ?? undefined,
    number:      row.number     ?? undefined,
    amount:      row.amount,
    balance:     row.balance,
    date:        row.date ?? undefined,
    is_deleted:  row.is_deleted === 1,
  };
}

function rowToExpense(row: ExpenseRow): Expense {
  return {
    id:            row.id,
    vendor_id:     row.vendor_id     ?? undefined,
    category_id:   row.category_id   ?? undefined,
    amount:        row.amount,
    date:          row.date           ?? undefined,
    payment_date:  row.payment_date   ?? undefined,
    public_notes:  row.public_notes   ?? undefined,
    is_deleted:    row.is_deleted     === 1,
    vendor_name:   row.vendor_name    ?? undefined,
    category_name: row.category_name  ?? undefined,
  };
}

function rowToClient(row: ClientRow): Client {
  return {
    id:                row.id,
    name:              row.name              ?? '',
    group_settings_id: row.group_settings_id ?? undefined,
    custom_value2:     row.custom_value2     ?? undefined,
    is_deleted:        row.is_deleted === 1,
  };
}

function rowToClientGroup(row: ClientGroupRow): ClientGroup {
  return { id: row.id, name: row.name ?? '' };
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Query the database and return all data slices required by `buildHoaReportData`.
 *
 * All queries use the indexes created in `SCHEMA_SQL` for maximum performance.
 * This function does NOT call the Invoice Ninja API — it only reads from the
 * local SQLite cache populated by `syncDb()`.
 */
export function queryForReport(
  db: InstanceType<typeof Database>,
  periodStart: Date,
  periodEnd: Date
): DbQueryResult {
  const startISO = format(periodStart, 'yyyy-MM-dd');
  const endISO   = format(periodEnd,   'yyyy-MM-dd');

  // All invoices up to period end (used for AR and invoice-date lookup in aging)
  const allInvoices = (db.prepare(`
    SELECT * FROM invoices
    WHERE date <= ? AND is_deleted = 0
  `).all(endISO) as InvoiceRow[]).map(rowToInvoice);

  // Invoices issued within the period (cuotas emitidas)
  const periodInvoices = (db.prepare(`
    SELECT * FROM invoices
    WHERE date >= ? AND date <= ? AND is_deleted = 0
  `).all(startISO, endISO) as InvoiceRow[]).map(rowToInvoice);

  // Payments received within the period
  const paymentRows = db.prepare(`
    SELECT * FROM payments
    WHERE date >= ? AND date <= ? AND is_deleted = 0
  `).all(startISO, endISO) as PaymentRow[];

  // All paymentables for those payments in one JOIN (avoids N+1 and the 999-variable SQLite limit)
  const paymentableRows = db.prepare(`
    SELECT pa.*
    FROM paymentables pa
    INNER JOIN payments p ON p.id = pa.payment_id
    WHERE p.date >= ? AND p.date <= ? AND p.is_deleted = 0
  `).all(startISO, endISO) as PaymentableRow[];

  // Group paymentables by payment_id for O(1) lookup
  const paymentablesMap = new Map<string, Array<{ invoice_id: string; amount: number }>>();
  for (const pa of paymentableRows) {
    let list = paymentablesMap.get(pa.payment_id);
    if (!list) { list = []; paymentablesMap.set(pa.payment_id, list); }
    list.push({ invoice_id: pa.invoice_id, amount: pa.amount });
  }

  // Assemble Payment objects with paymentables attached
  const periodPayments: Payment[] = paymentRows.map(row => ({
    id:                    row.id,
    client_id:             row.client_id    ?? undefined,
    client_name:           row.client_name  ?? undefined,
    amount:                row.amount,
    date:                  row.date         ?? undefined,
    transaction_reference: row.transaction_reference ?? undefined,
    is_deleted:            row.is_deleted   === 1,
    paymentables:          paymentablesMap.get(row.id) ?? [],
  }));

  // All expenses (not deleted) — used for AP outstanding balance
  const allExpenses = (db.prepare(`
    SELECT e.*, v.name AS vendor_name, c.name AS category_name
    FROM expenses e
    LEFT JOIN vendors v ON v.id = e.vendor_id
    LEFT JOIN expense_categories c ON c.id = e.category_id
    WHERE e.is_deleted = 0
  `).all() as ExpenseRow[]).map(rowToExpense);

  // Expenses within the period (gastos del período)
  const periodExpenses = (db.prepare(`
    SELECT e.*, v.name AS vendor_name, c.name AS category_name
    FROM expenses e
    LEFT JOIN vendors v ON v.id = e.vendor_id
    LEFT JOIN expense_categories c ON c.id = e.category_id
    WHERE e.date >= ? AND e.date <= ? AND e.is_deleted = 0
  `).all(startISO, endISO) as ExpenseRow[]).map(rowToExpense);

  // Clients (not deleted)
  const allClients = (db.prepare(`
    SELECT * FROM clients WHERE is_deleted = 0
  `).all() as ClientRow[]).map(rowToClient);

  // Client groups (all)
  const clientGroups = (db.prepare(`
    SELECT * FROM client_groups
  `).all() as ClientGroupRow[]).map(rowToClientGroup);

  return {
    allInvoices,
    periodInvoices,
    periodPayments,
    periodExpenses,
    allExpenses,
    allClients,
    clientGroups,
  };
}

