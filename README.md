# QuantHub Sales Rep Scorecard

Standalone HTML scorecard for QuantHub Higher Education sales team.  
Built by QuantHub · Internal use only.

## Setup (GitHub Pages)

1. Create a new GitHub repository
2. Upload `index.html` to the repository root
3. Go to **Settings → Pages → Source → Deploy from branch → main → / (root)**
4. GitHub will provide a URL: `https://yourusername.github.io/repo-name`
5. In HubSpot: **Dashboard → Add widget → External content / Custom widget → paste URL**

## HubSpot Widget Setup (Full Width)

For the best view in HubSpot dashboards:
1. When adding the Custom Widget, set width to **Full width** (12 columns)
2. Set height to **900px** or taller — the scorecard scrolls internally
3. The widget fills the available dashboard column width automatically

## Admin PIN

The **Load New Data** button is PIN-protected to prevent viewers from accidentally
clearing the scorecard. Default PIN: `2602`

To change the PIN:
1. Open `index.html` in a text editor
2. Find: `const ADMIN_PIN = '2602';`
3. Change to your preferred 4-digit PIN
4. Commit and push — deploys in ~60 seconds

## Weekly Update (Wednesday)

1. Export Higher Education deals pipeline as **CSV** from HubSpot CRM
2. Export Sales Activity report (last 7 days) as **XLSX** from HubSpot Reports
3. Open the scorecard URL → click **Load New Data** → enter PIN
4. Upload both files → review the **Data Sanity Check** screen
5. Enter weekly activity overrides (SMS touches, BANT %, daily verification)
6. Click **Build Scorecard** — data saves automatically for all viewers

## Scoring Weights

| Pillar | Weight |
|---|---|
| CW Revenue to Quota | 40% |
| Deal Velocity (pipeline coverage, stage advancement, stale deals) | 25% |
| Qualified Activity (meetings, calls, SMS) | 20% |
| Deal Quality (next step, amount, close date, BANT, stage flow) | 15% |
| Expansion Ownership Bonus | up to +8 pts |

Pipeline coverage benchmarks against **10× quota** ($1M per rep) — growth-stage target.

## Rep Filter

Only these reps appear in the scored scorecard:
- Joe DeRario
- Jason Rupert  
- Nate Spargo
- Michael Krause

All other deal owners (Walt, Josh, Emily) are visible in the Data Sanity Check screen
but excluded from the scorecard scoring. To change this, edit `REP_FILTER` in the script.

## Notes

- SMS/text touches are self-reported in standup — enter manually in overrides
- Matthew Fickling is on extended leave — his AUDIT deals remain in the pipeline export
- UNC Pembroke deal needs HubSpot amount/stage update
- Data persists in browser localStorage — viewers see the last uploaded scorecard
  automatically on page load without needing to re-upload
