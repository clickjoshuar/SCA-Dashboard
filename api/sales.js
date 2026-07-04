// /api/sales.js — Vercel serverless function
// Pulls WON deals from SCA's real pipelines (Inside Sales, Commercial, Distributor),
// plus owners and open pipeline, and returns aggregated data for the dashboard.
// Team is decided by PIPELINE so the roster self-maintains as reps come and go.
// Token never reaches the browser.

const HS = "https://api.hubapi.com";
const TOKEN = process.env.HUBSPOT_TOKEN;

// Which pipeline belongs to which team (matched by name, case-insensitive).
const TEAM_BY_PIPELINE = {
  "inside sales": "Inside",
  "commercial": "Outside",
  "distributor": "Outside",
};

// Manually managed inventory (update in Vercel env vars, no redeploy needed)
const JADE_INVENTORY_START = Number(process.env.JADE_INVENTORY_START || 1000);

// Monthly revenue goal for the pace bar. Null when unset -> dashboard hides the bar.
const MONTHLY_TARGET = process.env.MONTHLY_TARGET ? Number(process.env.MONTHLY_TARGET) : null;

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rate-limit-safe fetch: paces requests (~8/sec) and auto-retries on 429.
let lastCall = 0;
const MIN_GAP_MS = 120;
async function hsFetch(url, options = {}, attempt = 0) {
  const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastCall));
  if (wait) await sleep(wait);
  lastCall = Date.now();
  const r = await fetch(url, options);
  if (r.status === 429 && attempt < 5) {
    await sleep(500 * Math.pow(2, attempt));
    return hsFetch(url, options, attempt + 1);
  }
  return r;
}

// Read SCA's deal pipelines and figure out which stages count as "won".
// Revenue-recognition stages, confirmed by SCA. A deal counts as revenue when
// it reaches ANY of these stages in its pipeline (matched by exact stage ID).
//   Commercial:  Quote Approved + Closed Won
//   Inside Sales: Order Approved + Closed Won
//   Distributor: Order Shipped + Closed Won
const REVENUE_STAGE_IDS = {
  // Commercial
  "1355604553": "Outside", // Quote Approved
  "1320646543": "Outside", // Closed Won
  // Inside Sales
  "1355608437": "Inside",  // Order Approved
  "1341580175": "Inside",  // Closed Won
  // Distributor
  "1341577373": "Outside", // Order Shipped
  "1341577375": "Outside", // Closed Won
};

async function getPipelineConfig() {
  const r = await hsFetch(`${HS}/crm/v3/pipelines/deals`, { headers });
  if (!r.ok) throw new Error(`Pipelines fetch failed: ${r.status} ${await r.text()}`);
  const data = await r.json();

  const wonStageIds = Object.keys(REVENUE_STAGE_IDS);
  const stageTeam = { ...REVENUE_STAGE_IDS };
  const pipelineIds = [];
  const matched = [];

  for (const p of data.results || []) {
    const team = TEAM_BY_PIPELINE[(p.label || "").trim().toLowerCase()];
    if (!team) continue; // ignore pipelines we don't track
    pipelineIds.push(p.id);
    matched.push(p.label);
  }
  return { wonStageIds, pipelineIds, stageTeam, matched };
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

async function getOwnerNames() {
  const r = await hsFetch(`${HS}/crm/v3/owners?limit=500`, { headers });
  if (!r.ok) throw new Error(`Owners fetch failed: ${r.status}`);
  const data = await r.json();
  const names = {};
  for (const o of data.results || []) {
    names[o.id] = [o.firstName, o.lastName].filter(Boolean).join(" ") || o.email || `Owner ${o.id}`;
  }
  return names;
}

// Count product units from won deals' line items
async function getUnitsByProduct(dealIds) {
  const units = {};
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

    // 0. Figure out which pipelines + won stages to use
    const { wonStageIds, pipelineIds, stageTeam, matched } = await getPipelineConfig();

    // DEBUG: /api/sales?debug=1 dumps the raw pipeline config so we can see
    // exactly what HubSpot returns (every pipeline, every stage, won or not).
    if (req.query?.debug || (req.url || "").includes("debug=1")) {
      const raw = await hsFetch(`${HS}/crm/v3/pipelines/deals`, { headers });
      const rawData = raw.ok ? await raw.json() : { error: raw.status };
      const pipelineDump = (rawData.results || []).map((p) => ({
        label: p.label,
        id: p.id,
        matchedTeam: TEAM_BY_PIPELINE[(p.label || "").trim().toLowerCase()] || "(not matched)",
        stages: (p.stages || []).map((s) => ({
          label: s.label,
          id: s.id,
          probability: s.metadata?.probability,
          isClosed: s.metadata?.isClosed,
          countedAsWon: wonStageIds.includes(s.id),
        })),
      }));
      return res.status(200).json({
        matchedPipelines: matched,
        wonStageCount: wonStageIds.length,
        pipelines: pipelineDump,
      });
    }

    if (!wonStageIds.length) {
      return res.status(500).json({
        error: "No won stages found in Inside Sales / Commercial / Distributor pipelines. Check the pipeline names in HubSpot match exactly.",
      });
    }

    // 1. Won deals since Jan 1 last year (for YoY), in our pipelines' won stages
    const deals = await searchDeals(
      [
        { propertyName: "dealstage", operator: "IN", values: wonStageIds },
        { propertyName: "closedate", operator: "GTE", value: String(startLastYear) },
      ],
      ["amount", "closedate", "hubspot_owner_id", "dealstage", "pipeline"]
    );

    // 2. Open pipeline (still-open deals in our pipelines)
    const openDeals = await searchDeals(
      [
        { propertyName: "hs_is_closed", operator: "EQ", value: "false" },
        { propertyName: "pipeline", operator: "IN", values: pipelineIds },
      ],
      ["amount"]
    );
    const pipeline = {
      amount: openDeals.reduce((s, d) => s + Number(d.properties.amount || 0), 0),
      count: openDeals.length,
    };

    // 3. Owner display names
    const ownerNames = await getOwnerNames();

    // 4. Aggregate; team is derived from each deal's pipeline (via its won stage)
    const monthly = {};
    const lastYearMonthly = {};
    const daily = {};
    const thisYearDealIds = [];
    const ownerTeam = {}; // ownerId -> "Inside" | "Outside"

    for (const d of deals) {
      const amt = Number(d.properties.amount || 0);
      const owner = d.properties.hubspot_owner_id || "unassigned";
      const team = stageTeam[d.properties.dealstage] || "Inside";
      ownerTeam[owner] = team;

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

    // Build owners map (name + team) for everyone who has won deals
    const owners = {};
    for (const id of Object.keys(ownerTeam)) {
      owners[id] = { name: ownerNames[id] || `Owner ${id}`, team: ownerTeam[id] };
    }

    // 5. Product units from won deal line items
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
