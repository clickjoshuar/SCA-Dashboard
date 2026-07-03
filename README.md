# SCA Executive Sales Dashboard — HubSpot Setup

Live dashboard pulling closed-won revenue, pipeline, and product units
directly from HubSpot. ~20 minutes to deploy, no servers to manage.

## Step 1 — Create a HubSpot Private App (5 min)
1. In HubSpot: Settings (gear icon) → Integrations → **Private Apps** → Create private app
2. Name it "Executive Dashboard"
3. Scopes tab → check:
   - crm.objects.deals.read
   - crm.objects.owners.read
   - crm.objects.line_items.read
4. Create app → **copy the access token** (starts with "pat-")

## Step 2 — Put this project on GitHub (5 min)
1. Create a free GitHub account if needed
2. New repository → upload this entire folder (drag and drop works)

**Important:** keep the folder structure exactly as-is — especially the
`api/` folder with `sales.js` inside it. Vercel only runs files inside
`api/` as live functions. If `sales.js` ends up at the top level, the
dashboard will silently stay on sample data even with HubSpot connected.

## Step 3 — Deploy on Vercel (5 min)
1. Go to vercel.com → sign up with your GitHub account (free)
2. Add New → Project → import your repo
3. Before deploying, open **Environment Variables** and add:
   - HUBSPOT_TOKEN = (paste your pat- token)
   - JADE_INVENTORY_START = 1000        (your real starting count)
   - MONTHLY_TARGET = 1050000           (your revenue goal, no commas)
   - OUTSIDE_OWNER_IDS =                 (optional, see Step 4)
4. Click Deploy. You get a URL like sca-dashboard.vercel.app

## Step 4 — Tag your outside reps (optional, 5 min)
The dashboard splits Inside vs Outside by HubSpot owner ID.
Find IDs at Settings → Users & Teams (or via the owners API),
then set OUTSIDE_OWNER_IDS to a comma-separated list, e.g.:
  OUTSIDE_OWNER_IDS=81234567,81234568
Redeploy (Vercel → Deployments → Redeploy) after changing env vars.

## Step 5 — Share with the CEO
Send him the Vercel URL. It refreshes from HubSpot every 5 minutes
(cache header in api/sales.js). Bookmark it or leave it up on a TV.

## Updating inventory
Line items named "JADE" count automatically against JADE_INVENTORY_START.
If your true starting stock changes, update the env var — no code changes.

## Updating the monthly target
HubSpot doesn't have a "goal" field, so the target shown on the
pace bar is just a number you set yourself:
  Vercel → Settings → Environment Variables → edit MONTHLY_TARGET
Then Vercel → Deployments → Redeploy for the new number to take
effect. If MONTHLY_TARGET is missing entirely, the dashboard hides
the pace bar instead of guessing at a goal.

## Requirements for accurate data
- Deals must have: Amount, Close date, Deal owner
- Product units require **line items** on deals (Products in HubSpot).
  If reps don't add line items, revenue still works; unit counts won't.

## Optional: lock it down
Vercel → Settings → Deployment Protection can require a password/SSO
so only SCA people can view it.
