import express from "express";
import http from "http";
import {
  getBills,
  getBill,
  saveBill,
  updateBill,
  deleteBill,
  getRatePlans,
  saveRatePlan,
  deleteRatePlan,
  getSolarConfig,
  saveSolarConfig,
  getStats,
  upsertSolarGeneration,
  getSolarGenerationRange,
  getLatestGenerationDate,
  getFuelPurchases,
  saveFuelPurchase,
  deleteFuelPurchase,
} from "./db.js";

const PORT = process.env.PORT || 3007;

const app = express();
app.use(express.json());
app.use(express.static(new URL("public", import.meta.url).pathname));

// ── ECU helpers ───────────────────────────────────────────────────────────────

const ECU_URL = "http://192.168.0.58";
const ecuCache = {};
function fromCache(key, ttlMs) {
  const e = ecuCache[key];
  return e && Date.now() - e.ts < ttlMs ? e.data : null;
}
function setCache(key, data) {
  ecuCache[key] = { data, ts: Date.now() };
}

function ecuGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(ECU_URL + path, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString()));
      res.on("error", reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error("ECU timeout")));
    req.on("error", reject);
  });
}

function ecuPost(path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "192.168.0.58",
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString()));
      res.on("error", reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error("ECU timeout")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Save bill (Casey POSTs pre-extracted JSON directly)
app.post("/api/bills", async (req, res) => {
  try {
    const id = saveBill({ notes: null, ...req.body });
    res.json({ id });
  } catch (err) {
    if (err.message.includes("UNIQUE"))
      return res
        .status(409)
        .json({ error: "Bill already imported (duplicate statement number)" });
    res.status(500).json({ error: err.message });
  }
});

// List bills
app.get("/api/bills", (req, res) => {
  res.json(getBills());
});

// Get single bill
app.get("/api/bills/:id", (req, res) => {
  const bill = getBill(req.params.id);
  if (!bill) return res.status(404).json({ error: "Not found" });
  res.json(bill);
});

// Update bill fields
app.patch("/api/bills/:id", (req, res) => {
  try {
    updateBill(req.params.id, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete bill
app.delete("/api/bills/:id", (req, res) => {
  deleteBill(req.params.id);
  res.json({ ok: true });
});

// Fuel purchases
app.get("/api/fuel-purchases", (req, res) => res.json(getFuelPurchases()));

app.post("/api/fuel-purchases", (req, res) => {
  try {
    const id = saveFuelPurchase({
      source: "esso_email",
      notes: null,
      ...req.body,
    });
    res.json({ id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/fuel-purchases/:id", (req, res) => {
  deleteFuelPurchase(req.params.id);
  res.json({ ok: true });
});

// Rate plans
app.get("/api/rate-plans", (req, res) => res.json(getRatePlans()));

app.post("/api/rate-plans", (req, res) => {
  try {
    const id = saveRatePlan({ early_exit_fee: 0, notes: null, ...req.body });
    res.json({ id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/rate-plans/:id", (req, res) => {
  deleteRatePlan(req.params.id);
  res.json({ ok: true });
});

// Solar config
app.get("/api/solar", (req, res) => {
  res.json(getSolarConfig() || {});
});

app.put("/api/solar", (req, res) => {
  saveSolarConfig({ loan_term_months: 120, ...req.body });
  res.json(getSolarConfig());
});

// Dashboard stats
app.get("/api/stats", (req, res) => {
  const bills = getStats();
  const solar = getSolarConfig();

  // Per-bill export credit (what solar actually earned on each bill)
  const billsWithCredits = bills.map((b) => ({
    ...b,
    export_credit:
      b.grid_export_kwh && b.electricity_rate_kwh
        ? Math.round(
            b.grid_export_kwh *
              (b.electricity_rate_kwh + (b.electricity_emr_rate || 0)) *
              100,
          ) / 100
        : 0,
  }));

  const totals = {
    bills: bills.length,
    grid_import_kwh: bills.reduce((s, b) => s + (b.grid_import_kwh || 0), 0),
    grid_export_kwh: bills.reduce((s, b) => s + (b.grid_export_kwh || 0), 0),
    gas_usage_gj: bills.reduce((s, b) => s + (b.gas_usage_gj || 0), 0),
    total_spent: bills.reduce((s, b) => s + (b.total_amount || 0), 0),
    electricity_total: bills.reduce(
      (s, b) => s + (b.electricity_total || 0),
      0,
    ),
    gas_total: bills.reduce((s, b) => s + (b.gas_total || 0), 0),
    export_credits: billsWithCredits.reduce((s, b) => s + b.export_credit, 0),
  };

  // Solar ROI
  let roi = null;
  if (solar && solar.loan_start_date && bills.length > 0) {
    const start = new Date(solar.loan_start_date);
    const now = new Date();
    const monthsElapsed =
      (now.getFullYear() - start.getFullYear()) * 12 +
      (now.getMonth() - start.getMonth());
    const paidMonths = Math.min(monthsElapsed, solar.loan_term_months || 120);
    const cumLoanPaid = paidMonths * (solar.loan_monthly_payment || 0);
    const netInvestment =
      (solar.loan_amount || 0) - (solar.government_subsidy || 0);
    const cumSavings = totals.export_credits;
    roi = {
      months_elapsed: monthsElapsed,
      cum_loan_paid: Math.round(cumLoanPaid * 100) / 100,
      cum_savings: Math.round(cumSavings * 100) / 100,
      net_investment: Math.round(netInvestment * 100) / 100,
      net_position: Math.round((cumSavings - cumLoanPaid) * 100) / 100,
      savings_rate_per_month:
        monthsElapsed > 0
          ? Math.round((cumSavings / monthsElapsed) * 100) / 100
          : 0,
    };
    // Projected break-even: when cumSavings >= net investment (loan minus grant)
    if (roi.savings_rate_per_month > 0) {
      const monthsToBreakEven = Math.ceil(
        netInvestment / roi.savings_rate_per_month,
      );
      const breakEvenDate = new Date(start);
      breakEvenDate.setMonth(breakEvenDate.getMonth() + monthsToBreakEven);
      roi.break_even_date = breakEvenDate.toISOString().slice(0, 10);
      roi.break_even_months = monthsToBreakEven;
    }
  }

  res.json({ totals, bills: billsWithCredits, solar, roi });
});

// ── ECU / Solar live data ─────────────────────────────────────────────────────

app.get("/api/solar/realtime", async (req, res) => {
  const cached = fromCache("realtime", 30000);
  if (cached) return res.json(cached);
  try {
    const [rtHtml, energyHtml] = await Promise.all([
      ecuGet("/index.php/realtimedata"),
      ecuGet("/index.php/realtimedata/energy_graph"),
    ]);

    // Inverter table
    const invRows = [
      ...rtHtml.matchAll(
        /<td>(703\d+[-\d]+)\s*<\/td>\s*<td>\s*([\d.]+)\s*W\s*<\/td>\s*<td>\s*([\d.]+)\s*V/g,
      ),
    ];
    const inverters = invRows.map((m) => ({
      id: m[1].trim(),
      w: parseFloat(m[2]),
      dc_v: parseFloat(m[3]),
    }));
    const current_w = inverters.reduce((s, i) => s + i.w, 0);

    // Week total and today's kWh from energy_graph
    const weekMatch = energyHtml.match(
      /Solar Generated Current Week:\s*([\d.]+)\s*kWh/,
    );
    const week_kwh = weekMatch ? parseFloat(weekMatch[1]) : null;
    const dayDataMatch = energyHtml.match(/data:\s*\[([\d.,\s]+)\]/);
    let today_kwh = null;
    if (dayDataMatch) {
      const vals = dayDataMatch[1]
        .split(",")
        .map((v) => parseFloat(v.trim()))
        .filter((v) => !isNaN(v));
      today_kwh = vals[vals.length - 1] ?? null;
    }

    const tsMatch = rtHtml.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
    const result = {
      current_w,
      today_kwh,
      week_kwh,
      inverters,
      as_of: tsMatch?.[1] ?? new Date().toISOString().slice(0, 19),
    };
    setCache("realtime", result);
    res.json(result);
  } catch (e) {
    res.status(503).json({ error: "ECU unavailable: " + e.message });
  }
});

// Fetch one week of ECU data and upsert into DB. Returns number of days stored.
async function syncWeekFromECU(dateStr) {
  const qDate = new Date(dateStr);
  const qYear = qDate.getFullYear(),
    qMonth = qDate.getMonth() + 1;
  const raw = await ecuPost(
    "/index.php/realtimedata/old_energy_graph",
    `date=${dateStr}`,
  );
  const data = JSON.parse(raw);
  let count = 0;
  for (const entry of data.energy || []) {
    const [mo, dy] = entry.date.split("/").map(Number);
    let yr = qYear;
    if (qMonth === 1 && mo === 12) yr = qYear - 1;
    if (qMonth === 12 && mo === 1) yr = qYear + 1;
    const full = `${yr}-${String(mo).padStart(2, "0")}-${String(dy).padStart(2, "0")}`;
    upsertSolarGeneration(full, entry.energy);
    count++;
  }
  return count;
}

// Sync all weeks from `fromDate` up to today, 8 requests at a time.
async function syncGenerationRange(fromDate) {
  const today = new Date();
  const start = new Date(fromDate);
  const steps = Math.ceil((today - start) / (7 * 24 * 60 * 60 * 1000)) + 2;
  const queries = Array.from({ length: steps }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - i * 7);
    return d.toISOString().slice(0, 10);
  });
  const CONCURRENCY = 8;
  for (let i = 0; i < queries.length; i += CONCURRENCY) {
    await Promise.all(
      queries
        .slice(i, i + CONCURRENCY)
        .map((ds) => syncWeekFromECU(ds).catch(() => {})),
    );
  }
}

// On startup: catch up any missing days since last DB entry (or full backfill if empty)
const ECU_DATA_START = "2023-09-01";
(async () => {
  try {
    const latest = getLatestGenerationDate();
    const syncFrom = latest ?? ECU_DATA_START;
    console.log(`Syncing ECU generation from ${syncFrom}…`);
    await syncGenerationRange(syncFrom);
    console.log("ECU generation sync complete.");
  } catch (e) {
    console.warn("ECU startup sync failed (ECU may be offline):", e.message);
  }
})();

// Daily sync at 2am: pull the current week to pick up yesterday's reading
function scheduleDailySync() {
  const now = new Date();
  const next2am = new Date(now);
  next2am.setHours(2, 0, 0, 0);
  if (next2am <= now) next2am.setDate(next2am.getDate() + 1);
  setTimeout(async function tick() {
    try {
      await syncWeekFromECU(new Date().toISOString().slice(0, 10));
    } catch (e) {
      console.warn("Daily ECU sync failed:", e.message);
    }
    setTimeout(tick, 24 * 60 * 60 * 1000);
  }, next2am - now);
}
scheduleDailySync();

app.get("/api/solar/generation", (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 60, 1500);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const gen_days = getSolarGenerationRange(
    cutoff.toISOString().slice(0, 10),
    new Date().toISOString().slice(0, 10),
  );
  res.json({
    days: gen_days,
    total_kwh: +gen_days.reduce((s, d) => s + d.kwh, 0).toFixed(2),
  });
});

// Manual backfill trigger (in case ECU was offline at startup)
app.post("/api/solar/generation/sync", async (req, res) => {
  try {
    const from = req.body?.from ?? getLatestGenerationDate() ?? ECU_DATA_START;
    await syncGenerationRange(from);
    const count = getSolarGenerationRange(
      ECU_DATA_START,
      new Date().toISOString().slice(0, 10),
    ).length;
    res.json({ ok: true, days_in_db: count, synced_from: from });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

// Intraday 5-minute power samples for a given date (default: today).
// Proxies the ECU's old_power_graph endpoint, simplifies the payload, and
// caches per-date (5 min for today, 24 h for past dates since they're frozen).
app.get("/api/solar/intraday", async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const dateStr = req.query.date || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return res.status(400).json({ error: "date must be YYYY-MM-DD" });
  }
  const cacheKey = `intraday:${dateStr}`;
  const ttl = dateStr === today ? 5 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const cached = fromCache(cacheKey, ttl);
  if (cached) return res.json(cached);
  try {
    const raw = await ecuPost(
      "/index.php/realtimedata/old_power_graph",
      `date=${dateStr}`,
    );
    const data = JSON.parse(raw);
    const samples = (data.power || []).map((p) => ({
      ts: p.time,
      w: p.each_system_power,
    }));
    const peak_w = samples.reduce((m, p) => (p.w > m ? p.w : m), 0);
    const result = { date: dateStr, peak_w, samples };
    setCache(cacheKey, result);
    res.json(result);
  } catch (e) {
    res.status(503).json({ error: "ECU unavailable: " + e.message });
  }
});

app.listen(PORT, () => console.log(`Energy app running on port ${PORT}`));
