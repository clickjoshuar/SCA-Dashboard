// /api/sales.js — Vercel serverless function
// Pulls closed-won deals + owners + open pipeline from HubSpot and
// returns aggregated data for the dashboard. Token never reaches the browser.

const HS = "https://api.hubapi.com";
const TOKEN = process.env.HUBSPOT_TOKEN;

// Optional: comma-separated HubSpot owner IDs for the OUTSIDE team, e.g. "1234,5678"
const OUTSIDE_IDS = (process.env.OUTSIDE_OWNER_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

// Manually managed inventory numbers (update in Vercel env vars, no redeploy needed)
const JADE_INVENTORY_START = Number(process.env.JADE_INVENTORY_START || 1000);

// Monthly revenue goal for the pace bar. No sensible default, so null when unset —
// the dashboard hides the pace bar rather than inventing a target.
const MONTHLY_TARGET = process.env.MONTHLY_TARGET ? Number(process.env.MONTHLY_TARGET) : null;

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
};

// Small pause helper
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rate-limit-safe fetch: paces requests and auto-retries on 429 (HubSpot's
// per-second cap). Waits a moment and retries up to 5 times before giving up.
let lastCall = 0;
const MIN_GAP_MS = 120; // ~8 requests/sec, safely under HubSpot's limit
async function hsFetch(url, options = {}, attempt = 0) {
  const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastCall));
  if (wait) await sleep(wait);
  lastCall = Date.now();

  const r = await fetch(url, options);
  if (r.status === 429 && attempt < 5) {
    // Back off progressively: 0.5s, 1s, 2s, 4s, 8s
    await sleep(500 * Math.pow(2, attempt));
    return hsFetch(url, options, attempt + 1);
  }
  return r;
}

async function searchDeals(filters, properties, cap = 5000) {
  let results = [], after = undefined;
  do {
    const body = {
      filterGroups: [{ filters }],
      properties,
      limit: 200,
      ...(after ? { after } : {}),
    };
    const r = await hsFetch(`${HS}/crm/v3/objects/deals/search`, {
      method: "POST", headers, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`HubSpot deals search failed: ${r.status} ${await r.text()}`);
    const data = await r.json();
    results = results.concat(data.results || []);
    after = data.paging?.next?.after;
  } while (after && results.length < cap);
  return results;
}

async function getOwners() {
  const r = await hsFetch(`${HS}/crm/v3/owners?limit=500`, { headers });
  if (!r.ok) throw new Error(`Owners fetch failed: ${r.status}`);
  const data = await r.json();
  const map = {};
  for (const o of data.results || []) {
    map[o.id] = {
      name: [o.firstName, o.lastName].filter(Boolean).join(" ") || o.email || `Owner ${o.id}`,
      team: OUTSIDE_IDS.includes(String(o.id)) ? "Outside" : "Inside",
    };
  }
  return map;
}

// Fetch line items for a set of deal IDs to count units per product
async function getUnitsByProduct(dealIds) {
  const units = {}; // { "JADE 2.0": 12, ... }
  let jadeUnits = 0;
  for (let i = 0; i < dealIds.length; i += 500) {
    const batch = dealIds.slice(i, i + 500);
    const ar = await hsFetch(`${HS}/crm/v4/associations/deals/line_items/batch/read`, {
      method: "POST", headers,
      body: JSON.stringify({ inputs: batch.map(id => ({ id })) }),
    });
    if (!ar.ok) continue;
    const assoc = await ar.json();
    const liIds = (assoc.results || []).flatMap(x => (x.to || []).map(t => t.toObjectId));
    for (let j = 0; j < liIds.length; j += 100) {
      const lr = await hsFetch(`${HS}/crm/v3/objects/line_items/batch/read`, {
        method: "POST", headers,
        body: JSON.stringify({
          inputs: liIds.slice(j, j + 100).map(id => ({ id: String(id) })),
          properties: ["name", "quantity"],
        }),
      });
      if (!lr.ok) continue;
      const lines = await lr.json();
      for (const li of lines.results || []) {
        const name = (li.properties.name || "Other").toUpperCase();
        const qty = Number(li.properties.quantity || 1);
        const key =
          name.includes("JADE") ? "JADE 2.0" :
          name.includes("COBALT") ? "COBALT" :
          name.includes("ONYX") ? "ONYX" :
          name.includes("FILTER") ? "Filters" : "Other";
        units[key] = (units[key] || 0) + qty;
        if (key === "JADE 2.0") jadeUnits += qty;
      }
    }
  }
  return { units, jadeUnits };
}

export default async function handler(req, res) {
  try {
    if (!TOKEN) return res.status(500).json({ error: "HUBSPOT_TOKEN env var not set" });

    const now = new Date();
    const thisYear = now.getFullYear();
    const startLastYear = Date.UTC(thisYear - 1, 0, 1);

    // 1. All closed-won deals since Jan 1 of LAST year (for YoY)
    const deals = await searchDeals(
      [
        { propertyName: "hs_is_closed_won", operator: "EQ", value: "true" },
        { propertyName: "closedate", operator: "GTE", value: String(startLastYear) },
      ],
      ["amount", "closedate", "hubspot_owner_id"]
    );

    // 2. Open pipeline
    const openDeals = await searchDeals(
      [{ propertyName: "hs_is_closed", operator: "EQ", value: "false" }],
      ["amount"]
    );
    const pipeline = {
      amount: openDeals.reduce((s, d) => s + Number(d.properties.amount || 0), 0),
      count: openDeals.length,
    };

    // 3. Owners
    const owners = await getOwners();

    // 4. Aggregate
    const monthly = {};        // "2026-06" -> { total, byRep: {ownerId: rev} }
    const lastYearMonthly = {}; // "2025-06" -> total
    const daily = {};           // day of current month -> { total, byRep }
    const thisYearDealIds = [];

    for (const d of deals) {
      const amt = Number(d.properties.amount || 0);
      const owner = d.properties.hubspot_owner_id || "unassigned";
      const dt = new Date(d.properties.closedate);
      const ym = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;

      if (dt.getUTCFullYear() === thisYear) {
        thisYearDealIds.push(d.id);
        monthly[ym] ??= { total: 0, byRep: {} };
        monthly[ym].total += amt;
        monthly[ym].byRep[owner] = (monthly[ym].byRep[owner] || 0) + amt;

        if (dt.getUTCMonth() === now.getUTCMonth()) {
          const day = dt.getUTCDate();
          daily[day] ??= { total: 0, byRep: {} };
          daily[day].total += amt;
          daily[day].byRep[owner] = (daily[day].byRep[owner] || 0) + amt;
        }
      } else {
        lastYearMonthly[ym] = (lastYearMonthly[ym] || 0) + amt;
      }
    }

    // 5. Units per product from line items (this year's won deals)
    const { units, jadeUnits } = await getUnitsByProduct(thisYearDealIds);

    res.setHeader("Cache-Control", "s-maxage=300"); // cache 5 min
    res.status(200).json({
      generatedAt: now.toISOString(),
      owners, monthly, lastYearMonthly, daily, pipeline,
      monthlyTarget: MONTHLY_TARGET,
      unitsByProduct: units,
      inventory: {
        start: JADE_INVENTORY_START,
        left: Math.max(JADE_INVENTORY_START - jadeUnits, 0),
        jadeSoldYTD: jadeUnits,
      },
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
