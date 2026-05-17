import Database from "better-sqlite3";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(join(DATA_DIR, "energy.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS solar_generation (
    date TEXT PRIMARY KEY,
    kwh REAL NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    statement_number TEXT UNIQUE,
    statement_date TEXT NOT NULL,
    payment_due_date TEXT,
    electricity_period_start TEXT,
    electricity_period_end TEXT,
    gas_period_start TEXT,
    gas_period_end TEXT,
    grid_import_kwh REAL DEFAULT 0,
    grid_export_kwh REAL DEFAULT 0,
    electricity_rate_kwh REAL,
    electricity_emr_rate REAL,
    electricity_retailer_charges REAL,
    electricity_distributor_charges REAL,
    electricity_total REAL,
    gas_usage_gj REAL DEFAULT 0,
    gas_retailer_charges REAL,
    gas_distributor_charges REAL,
    gas_total REAL,
    multisite_credit REAL DEFAULT 0,
    gst REAL,
    total_amount REAL,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rate_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    utility TEXT NOT NULL,
    site_id TEXT,
    plan_name TEXT NOT NULL,
    effective_from TEXT,
    effective_until TEXT,
    admin_fee_per_day REAL,
    emr_rate REAL,
    energy_rate_type TEXT,
    energy_rate_fixed REAL,
    early_exit_fee INTEGER DEFAULT 0,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS fuel_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    amount REAL NOT NULL,
    litres REAL NOT NULL,
    price_per_litre REAL NOT NULL,
    station TEXT,
    city TEXT,
    province TEXT,
    source TEXT DEFAULT 'esso_email',
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS solar_config (
    id INTEGER PRIMARY KEY DEFAULT 1,
    installation_date TEXT,
    total_cost REAL,
    government_subsidy REAL,
    loan_amount REAL,
    loan_monthly_payment REAL,
    loan_term_months INTEGER DEFAULT 120,
    loan_start_date TEXT,
    notes TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

export function getBills() {
  return db
    .prepare(
      `
    SELECT id, statement_number, statement_date, payment_due_date,
           electricity_period_start, electricity_period_end,
           gas_period_start, gas_period_end,
           grid_import_kwh, grid_export_kwh, electricity_rate_kwh,
           electricity_total, gas_usage_gj, gas_total,
           multisite_credit, gst, total_amount, notes, created_at
    FROM bills ORDER BY statement_date DESC
  `,
    )
    .all();
}

export function getBill(id) {
  return db.prepare("SELECT * FROM bills WHERE id = ?").get(id);
}

export function saveBill(data) {
  const stmt = db.prepare(`
    INSERT INTO bills (
      statement_number, statement_date, payment_due_date,
      electricity_period_start, electricity_period_end,
      gas_period_start, gas_period_end,
      grid_import_kwh, grid_export_kwh, electricity_rate_kwh, electricity_emr_rate,
      electricity_retailer_charges, electricity_distributor_charges, electricity_total,
      gas_usage_gj, gas_retailer_charges, gas_distributor_charges, gas_total,
      multisite_credit, gst, total_amount, notes
    ) VALUES (
      @statement_number, @statement_date, @payment_due_date,
      @electricity_period_start, @electricity_period_end,
      @gas_period_start, @gas_period_end,
      @grid_import_kwh, @grid_export_kwh, @electricity_rate_kwh, @electricity_emr_rate,
      @electricity_retailer_charges, @electricity_distributor_charges, @electricity_total,
      @gas_usage_gj, @gas_retailer_charges, @gas_distributor_charges, @gas_total,
      @multisite_credit, @gst, @total_amount, @notes
    )
  `);
  const result = stmt.run(data);
  return result.lastInsertRowid;
}

export function updateBill(id, fields) {
  const sets = Object.keys(fields)
    .map((k) => `${k} = @${k}`)
    .join(", ");
  if (!sets) return;
  db.prepare(`UPDATE bills SET ${sets} WHERE id = @id`).run({ ...fields, id });
}

export function deleteBill(id) {
  return db.prepare("DELETE FROM bills WHERE id = ?").run(id);
}

export function getRatePlans() {
  return db
    .prepare("SELECT * FROM rate_plans ORDER BY utility, effective_from DESC")
    .all();
}

export function saveRatePlan(data) {
  const result = db
    .prepare(
      `
    INSERT INTO rate_plans (utility, site_id, plan_name, effective_from, effective_until,
      admin_fee_per_day, emr_rate, energy_rate_type, energy_rate_fixed, early_exit_fee, notes)
    VALUES (@utility, @site_id, @plan_name, @effective_from, @effective_until,
      @admin_fee_per_day, @emr_rate, @energy_rate_type, @energy_rate_fixed, @early_exit_fee, @notes)
  `,
    )
    .run(data);
  return result.lastInsertRowid;
}

export function deleteRatePlan(id) {
  return db.prepare("DELETE FROM rate_plans WHERE id = ?").run(id);
}

export function getSolarConfig() {
  return db.prepare("SELECT * FROM solar_config WHERE id = 1").get();
}

export function saveSolarConfig(data) {
  db.prepare(
    `
    INSERT INTO solar_config (id, installation_date, total_cost, government_subsidy,
      loan_amount, loan_monthly_payment, loan_term_months, loan_start_date, notes, updated_at)
    VALUES (1, @installation_date, @total_cost, @government_subsidy,
      @loan_amount, @loan_monthly_payment, @loan_term_months, @loan_start_date, @notes, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      installation_date = excluded.installation_date,
      total_cost = excluded.total_cost,
      government_subsidy = excluded.government_subsidy,
      loan_amount = excluded.loan_amount,
      loan_monthly_payment = excluded.loan_monthly_payment,
      loan_term_months = excluded.loan_term_months,
      loan_start_date = excluded.loan_start_date,
      notes = excluded.notes,
      updated_at = excluded.updated_at
  `,
  ).run(data);
}

export function upsertSolarGeneration(date, kwh) {
  db.prepare(
    `
    INSERT INTO solar_generation (date, kwh) VALUES (?, ?)
    ON CONFLICT(date) DO UPDATE SET kwh = excluded.kwh
  `,
  ).run(date, kwh);
}

export function getSolarGenerationRange(start, end) {
  return db
    .prepare(
      "SELECT date, kwh FROM solar_generation WHERE date >= ? AND date <= ? ORDER BY date ASC",
    )
    .all(start, end);
}

export function getLatestGenerationDate() {
  return (
    db
      .prepare("SELECT date FROM solar_generation ORDER BY date DESC LIMIT 1")
      .get()?.date ?? null
  );
}

export function getFuelPurchases() {
  return db.prepare("SELECT * FROM fuel_purchases ORDER BY date ASC").all();
}

export function saveFuelPurchase(data) {
  const result = db
    .prepare(
      `
    INSERT INTO fuel_purchases (date, amount, litres, price_per_litre, station, city, province, source, notes)
    VALUES (@date, @amount, @litres, @price_per_litre, @station, @city, @province, @source, @notes)
  `,
    )
    .run(data);
  return result.lastInsertRowid;
}

export function deleteFuelPurchase(id) {
  return db.prepare("DELETE FROM fuel_purchases WHERE id = ?").run(id);
}

export function getStats() {
  const bills = db
    .prepare(
      `
    SELECT statement_date, electricity_period_start, electricity_period_end,
           grid_import_kwh, grid_export_kwh, electricity_rate_kwh, electricity_emr_rate,
           electricity_total, gas_usage_gj, gas_total, total_amount, multisite_credit
    FROM bills ORDER BY statement_date ASC
  `,
    )
    .all();
  return bills;
}
