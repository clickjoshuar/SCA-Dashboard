import React, { useState, useEffect, useMemo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend, Cell,
} from "recharts";

const C = {
  navy: "#081C33", navyMid: "#0F2A4A", accent: "#2E7CF6", accentSoft: "#7FB0FA",
  ice: "#EDF4FC", bg: "#F7FAFD", card: "#FFFFFF", text: "#0B1F36",
  muted: "#64809E", line: "#E3ECF5", green: "#0E9F6E", red: "#DF4B4B", gold: "#E8B44C",
};

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const fmt$ = (n) =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n).toLocaleString()}`;
const full$ = (n) => `$${Math.round(n).toLocaleString()}`;

/* ——— Sample fallback so the dashboard renders before HubSpot is connected ——— */
function sampleData() {
  const seeded = (i) => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  const owners = {};
  const names = ["Geoffrey LaCava","Charles Hou","David Demus","John Petrunia","Karin Claveria","M. Torres","S. Whitfield"];
  names.forEach((n, i) => { owners[String(i + 1)] = { name: n, team: i < 5 ? "Inside" : "Outside" }; });
  const monthly = {}, lastYearMonthly = {}, daily = {};
  for (let m = 0; m < 6; m++) {
    const key = `2026-${String(m + 1).padStart(2, "0")}`;
    monthly[key] = { total: 0, byRep: {} };
    Object.keys(owners).forEach((id, r) => {
      const rev = Math.round((30000 + seeded(r * 20 + m) * 90000 + m * 6000));
      monthly[key].byRep[id] = rev; monthly[key].total += rev;
    });
    lastYearMonthly[`2025-${String(m + 1).padStart(2, "0")}`] = Math.round(720000 + seeded(m + 60) * 240000);
  }
  for (let d = 1; d <= 30; d++) {
    if (d % 7 === 0 || d % 7 === 6) continue;
    daily[d] = { total: 0, byRep: {} };
    Object.keys(owners).forEach((id, r) => {
      const rev = Math.round(seeded(r * 97 + d) * 14000);
      daily[d].byRep[id] = rev; daily[d].total += rev;
    });
  }
  return {
    sample: true, owners, monthly, lastYearMonthly, daily,
    monthlyTarget: 1050000,
    pipeline: { amount: 1837500, count: 64 },
    unitsByProduct: { "JADE 2.0": 318, COBALT: 122, ONYX: 74, Filters: 240 },
    inventory: { start: 1000, left: 682, jadeSoldYTD: 318 },
  };
}

function InventoryRing({ left, start }) {
  const pct = start ? left / start : 0;
  const R = 56, CIRC = 2 * Math.PI * R;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
      <svg width="136" height="136" viewBox="0 0 136 136">
        <circle cx="68" cy="68" r={R} fill="none" stroke={C.ice} strokeWidth="11" />
        <circle cx="68" cy="68" r={R} fill="none" stroke={C.accent} strokeWidth="11"
          strokeLinecap="round" strokeDasharray={CIRC} strokeDashoffset={CIRC * (1 - pct)}
          transform="rotate(-90 68 68)" style={{ transition: "stroke-dashoffset 1.2s ease" }} />
        <text x="68" y="64" textAnchor="middle" fontSize="27" fontWeight="800" fill={C.navy}>{left}</text>
        <text x="68" y="84" textAnchor="middle" fontSize="10" fill={C.muted} letterSpacing="1.2">UNITS LEFT</text>
      </svg>
      <div>
        <div style={{ fontSize: 20, fontWeight: 800, color: C.navy }}>{Math.round((1 - pct) * 100)}% sold</div>
        <div style={{ fontSize: 12.5, color: C.muted, marginTop: 3 }}>{start - left} of {start} JADE 2.0 units moved</div>
      </div>
    </div>
  );
}

function PaceBar({ actual, target }) {
  const pct = target ? Math.min((actual / target) * 100, 100) : 0;
  const dayOfMonth = new Date().getDate();
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const expected = (dayOfMonth / daysInMonth) * 100;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: C.muted, marginBottom: 6 }}>
        <span>{full$(actual)}</span><span>Target {full$(target)}</span>
      </div>
      <div style={{ position: "relative", height: 12, background: C.ice, borderRadius: 99 }}>
        <div style={{ width: `${pct}%`, height: "100%", borderRadius: 99,
          background: pct >= expected - 5 ? C.green : C.gold, transition: "width 1s ease" }} />
        <div style={{ position: "absolute", left: `${expected}%`, top: -3, bottom: -3, width: 2, background: C.navy, opacity: 0.35 }} />
      </div>
      <div style={{ fontSize: 12.5, color: C.muted, marginTop: 6 }}>
        {pct.toFixed(0)}% of target · marker shows where today should be
      </div>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState("month");
  const [team, setTeam] = useState("All");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch("/api/sales")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`API ${r.status}`))))
      .then(setData)
      .catch((e) => { setError(String(e.message || e)); setData(sampleData()); });
  }, []);

  const derived = useMemo(() => {
    if (!data) return null;
    const owners = data.owners || {};
    const inTeam = (id) => team === "All" || (owners[id]?.team || "Inside") === team;

    const now = new Date();
    const thisYear = now.getFullYear();
    const curKey = `${thisYear}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    const monthKeys = Object.keys(data.monthly || {}).sort();
    const yoy = monthKeys.map((k) => {
      const [, m] = k.split("-");
      const lyKey = `${thisYear - 1}-${m}`;
      return {
        month: MONTH_NAMES[Number(m) - 1],
        [String(thisYear)]: data.monthly[k].total,
        [String(thisYear - 1)]: data.lastYearMonthly?.[lyKey] || 0,
      };
    });

    const source = view === "month"
      ? (data.monthly?.[curKey]?.byRep || {})
      : Object.values(data.daily || {}).length
        ? (data.daily?.[Math.max(...Object.keys(data.daily).map(Number))]?.byRep || {})
        : {};

    const repTotals = Object.entries(source)
      .filter(([id]) => inTeam(id))
      .map(([id, rev]) => ({
        name: owners[id]?.name || "Unassigned",
        team: owners[id]?.team || "Inside",
        revenue: rev,
      }))
      .sort((a, b) => b.revenue - a.revenue);

    const trend = view === "month"
      ? monthKeys.map((k) => {
          const [, m] = k.split("-");
          const filtered = Object.entries(data.monthly[k].byRep)
            .filter(([id]) => inTeam(id)).reduce((s, [, v]) => s + v, 0);
          return { label: MONTH_NAMES[Number(m) - 1], revenue: filtered };
        })
      : Object.keys(data.daily || {}).sort((a, b) => a - b).map((d) => {
          const filtered = Object.entries(data.daily[d].byRep)
            .filter(([id]) => inTeam(id)).reduce((s, [, v]) => s + v, 0);
          return { label: d, revenue: filtered };
        });

    const productMix = Object.entries(data.unitsByProduct || {})
      .map(([name, units]) => ({ name, units }));

    const periodRevenue = repTotals.reduce((s, r) => s + r.revenue, 0);
    const ytdThis = yoy.reduce((s, m) => s + (m[String(thisYear)] || 0), 0);
    const ytdLast = yoy.reduce((s, m) => s + (m[String(thisYear - 1)] || 0), 0);
    const yoyPct = ytdLast ? ((ytdThis - ytdLast) / ytdLast) * 100 : 0;
    const monthRevenueAll = data.monthly?.[curKey]?.total || 0;

    return { repTotals, trend, yoy, productMix, periodRevenue, ytdThis, ytdLast, yoyPct, monthRevenueAll, thisYear };
  }, [data, view, team]);

  if (!data || !derived) {
    return <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: C.bg,
      fontFamily: "system-ui", color: C.muted }}>Loading live sales data…</div>;
  }

  const { repTotals, trend, yoy, productMix, periodRevenue, ytdThis, ytdLast, yoyPct, monthRevenueAll, thisYear } = derived;
  const periodLabel = view === "month"
    ? new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" })
    : `Today · ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'Manrope','Segoe UI',system-ui,sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@500;700;800&display=swap');
        .card{background:${C.card};border:1px solid ${C.line};border-radius:14px;padding:20px 22px;}
        .kpiLabel{font-size:11.5px;letter-spacing:1.4px;text-transform:uppercase;color:${C.muted};font-weight:700;}
        .kpiValue{font-size:30px;font-weight:800;color:${C.navy};margin-top:6px;font-variant-numeric:tabular-nums;}
        .pill{border:none;padding:7px 16px;border-radius:9px;font-weight:700;font-size:13.5px;cursor:pointer;font-family:inherit;transition:all .15s;}
        @media (prefers-reduced-motion:reduce){*{transition:none !important;}}
      `}</style>

      <div style={{ background: C.navy, padding: "22px clamp(16px,4vw,48px)", color: "#fff" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 14 }}>
          <div>
            <div style={{ fontSize: 12, letterSpacing: 2.5, color: C.accentSoft, fontWeight: 700 }}>SURGICALLY CLEAN AIR®</div>
            <div style={{ fontSize: 22, fontWeight: 800, marginTop: 2 }}>Executive Sales Dashboard</div>
            <div style={{ fontSize: 13, color: "#9FB6CE", marginTop: 2 }}>
              {periodLabel}{data.sample ? " · SAMPLE DATA (HubSpot not connected)" : ` · live from HubSpot`}
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <div style={{ background: "rgba(255,255,255,.08)", borderRadius: 11, padding: 4, display: "flex", gap: 4 }}>
              {["All", "Inside", "Outside"].map((t) => (
                <button key={t} className="pill" onClick={() => setTeam(t)}
                  style={{ background: team === t ? C.accent : "transparent", color: team === t ? "#fff" : "#B9CCE2" }}>{t}</button>
              ))}
            </div>
            <div style={{ background: "rgba(255,255,255,.08)", borderRadius: 11, padding: 4, display: "flex", gap: 4 }}>
              {["month", "day"].map((v) => (
                <button key={v} className="pill" onClick={() => setView(v)}
                  style={{ background: view === v ? "#fff" : "transparent", color: view === v ? C.navy : "#B9CCE2" }}>
                  {v === "month" ? "Monthly" : "Daily"}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div style={{ padding: "24px clamp(16px,4vw,48px)" }}>
        {error && data.sample && (
          <div style={{ background: "#FFF6E5", border: "1px solid #F1D9A7", borderRadius: 12, padding: "10px 16px",
            fontSize: 13, color: "#8A6D1F", marginBottom: 14 }}>
            Showing sample data — API said: {error}. Check HUBSPOT_TOKEN in Vercel env vars.
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(215px,1fr))", gap: 14, marginBottom: 14 }}>
          <div className="card">
            <div className="kpiLabel">Revenue · {view === "month" ? "This Month" : "Today"}</div>
            <div className="kpiValue">{fmt$(periodRevenue)}</div>
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 3 }}>{team} team · {full$(periodRevenue)}</div>
          </div>
          <div className="card">
            <div className="kpiLabel">YTD vs {thisYear - 1}</div>
            <div className="kpiValue" style={{ color: yoyPct >= 0 ? C.green : C.red }}>
              {yoyPct >= 0 ? "▲" : "▼"} {Math.abs(yoyPct).toFixed(1)}%
            </div>
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 3 }}>{fmt$(ytdThis)} vs {fmt$(ytdLast)}</div>
          </div>
          <div className="card">
            <div className="kpiLabel">Open Pipeline</div>
            <div className="kpiValue">{fmt$(data.pipeline?.amount || 0)}</div>
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 3 }}>{data.pipeline?.count || 0} open deals in HubSpot</div>
          </div>
          <div className="card">
            <div className="kpiLabel">JADE 2.0 Sold YTD</div>
            <div className="kpiValue">{data.inventory?.jadeSoldYTD ?? "—"}</div>
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 3 }}>From deal line items</div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 14, marginBottom: 14 }}>
          <div className="card">
            <div className="kpiLabel" style={{ marginBottom: 14 }}>Pace to Monthly Target</div>
            {data.monthlyTarget ? (
              <PaceBar actual={monthRevenueAll} target={data.monthlyTarget} />
            ) : (
              <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.5 }}>
                No monthly target set. Add <code>MONTHLY_TARGET</code> in Vercel →
                Settings → Environment Variables, then redeploy.
              </div>
            )}
          </div>
          <div className="card">
            <div className="kpiLabel" style={{ marginBottom: 8 }}>JADE 2.0 Inventory Countdown</div>
            <InventoryRing left={data.inventory?.left ?? 0} start={data.inventory?.start ?? 0} />
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", gap: 14, marginBottom: 14 }}>
          <div className="card">
            <div style={{ fontWeight: 800, color: C.navy }}>Revenue by Rep</div>
            <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 12 }}>
              {periodLabel} · <span style={{ color: C.accent }}>■</span> Inside&nbsp;&nbsp;<span style={{ color: C.navy }}>■</span> Outside
            </div>
            <ResponsiveContainer width="100%" height={Math.max(repTotals.length * 38, 180)}>
              <BarChart data={repTotals} layout="vertical" margin={{ left: 6, right: 24 }}>
                <CartesianGrid horizontal={false} stroke={C.line} />
                <XAxis type="number" tickFormatter={fmt$} tick={{ fontSize: 12, fill: C.muted }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 12.5, fill: C.navy, fontWeight: 700 }} axisLine={false} tickLine={false} />
                <Tooltip formatter={(v) => full$(v)} contentStyle={{ borderRadius: 10, border: `1px solid ${C.line}` }} />
                <Bar dataKey="revenue" radius={[0, 7, 7, 0]} barSize={18}>
                  {repTotals.map((r, i) => <Cell key={i} fill={r.team === "Inside" ? C.accent : C.navy} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="card">
            <div style={{ fontWeight: 800, color: C.navy }}>Product Mix · Units YTD</div>
            <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 12 }}>From HubSpot deal line items</div>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={productMix} margin={{ right: 12 }}>
                <CartesianGrid vertical={false} stroke={C.line} />
                <XAxis dataKey="name" tick={{ fontSize: 12.5, fill: C.navy, fontWeight: 700 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 12, fill: C.muted }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={{ borderRadius: 10, border: `1px solid ${C.line}` }} />
                <Bar dataKey="units" fill={C.accent} radius={[6, 6, 0, 0]} barSize={44} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", gap: 14, marginBottom: 14 }}>
          <div className="card">
            <div style={{ fontWeight: 800, color: C.navy }}>Revenue Trend</div>
            <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 12 }}>
              {view === "month" ? `By month, ${thisYear}` : "By day, this month"} · {team} team
            </div>
            <ResponsiveContainer width="100%" height={230}>
              <BarChart data={trend} margin={{ right: 12 }}>
                <CartesianGrid vertical={false} stroke={C.line} />
                <XAxis dataKey="label" tick={{ fontSize: 12, fill: C.muted }} axisLine={false} tickLine={false} interval={view === "day" ? 2 : 0} />
                <YAxis tickFormatter={fmt$} tick={{ fontSize: 12, fill: C.muted }} axisLine={false} tickLine={false} />
                <Tooltip formatter={(v) => full$(v)} contentStyle={{ borderRadius: 10, border: `1px solid ${C.line}` }} />
                <Bar dataKey="revenue" fill={C.accent} radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="card">
            <div style={{ fontWeight: 800, color: C.navy }}>Revenue vs Last Year</div>
            <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 12 }}>All teams · monthly</div>
            <ResponsiveContainer width="100%" height={230}>
              <BarChart data={yoy} margin={{ right: 12 }}>
                <CartesianGrid vertical={false} stroke={C.line} />
                <XAxis dataKey="month" tick={{ fontSize: 12.5, fill: C.muted }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={fmt$} tick={{ fontSize: 12, fill: C.muted }} axisLine={false} tickLine={false} />
                <Tooltip formatter={(v) => full$(v)} contentStyle={{ borderRadius: 10, border: `1px solid ${C.line}` }} />
                <Legend wrapperStyle={{ fontSize: 12.5, fontWeight: 700 }} />
                <Bar dataKey={String(thisYear - 1)} fill={C.ice} stroke={C.line} radius={[5, 5, 0, 0]} />
                <Bar dataKey={String(thisYear)} fill={C.navy} radius={[5, 5, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div style={{ textAlign: "center", fontSize: 12, color: C.muted, marginTop: 6 }}>
          {data.sample ? "Sample data — deploy with your HubSpot token to go live."
            : `Live · refreshed ${new Date(data.generatedAt).toLocaleTimeString()}`}
        </div>
      </div>
    </div>
  );
}
