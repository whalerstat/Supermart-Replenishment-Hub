# Replenishment & Availability Hub — governed pipeline + Agent Decisions

A two-screen Databricks App for the final-round "Build, Demo, Pitch!" story about Harmoni Mart, a fictional Singapore grocer.

| Screen                           | What the panel sees                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 · Data foundation pipeline** | Press **Run job**. Four sources land in an empty "unified governed data foundation", which fills **bronze → silver → gold**. The forecasting ML job then trains, backtests and registers a model, and the job refreshes an **Insights dashboard** and feeds the **Agent Decisions** app.                                                                                                                            |
| **2 · Agent Decisions**          | Two signals, each with a chart and forecast. Below each signal are two costed agent recommendations. Choosing one opens an **e-mail draft panel**. Claude drafts it through the AI Gateway, grounded on gold and the supplier agreements. A planner edits it and approves (human in the loop). The app then queues the e-mail to the store manager, writes the order back to store ordering, and logs the decision. |

**All data is fictional.** Stores, people, suppliers and numbers come from a deterministic seed. "Sent" e-mails are rows in `outbox` marked `queued (mock - never sent)`. The business date is pinned to **Mon 21 Dec 2026**, so every number is the same on every run.

## The two signals

1. **Winter apparel stock-out at Changi City.** The customer behaviour API shows 338 loyalty members from this store flying to cold destinations in the next 10 days (13× early November), and winter apparel sales follow those departures. 64 units are on hand against a 7-day forecast of 227. Jackets run out on Tue 22 Dec, and the next NorthPeak delivery lands on Mon 28 Dec.
   - **A (agent's pick):** expedite a DC order that arrives on Wed 23 Dec. It protects S$4.4k of sales for S$172 of freight.
   - **B:** next-day transfers from three low-travel stores. It is cheaper and a day earlier, but covers only 73% of the need because donor stores must keep 21 days of cover.
2. **Excess year-end fresh order at Tampines Central.** PO-7731 (1,724 units for 28–31 Dec) was copied from last year (+3%). Last year that week ran the Year-end Fresh Fest (+45%), which moves to Lunar New Year this time, and 12% of the store's households will be away. The forecast is 1,097 units, so the order is 57% over and puts S$1.5k of waste at risk.
   - **A:** amend the PO to forecast plus half a day of safety stock before Greenleaf's cut-off (14:00, Wed 23 Dec).
   - **B:** split it into two deliveries, so salmon and New Year's Eve stock arrive fresh.

## How it covers the four layers

| Layer                               | Where it shows                                                | What to say                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1 · Governed foundation**         | Screen 1, foundation box + "Governance in Unity Catalog"      | Four source types (managed Postgres, Lakehouse/relational, two real-time SaaS APIs) unify around **one entity: product × store × day**. **Lineage:** every row in bronze carries source, object and load time; gold traces back to source rows. **Quality:** 6 expectations; 24 replayed POS rows dropped, 7 bad stock and booking messages quarantined (not deleted). **Access:** member identity hashed in silver, e-mails never leave bronze, store managers row-filtered to their store, and the app's service principal reads gold and writes only the outbox and draft orders. |
| **2 · Predictive model**            | Screen 1 ML node + dashboard preview; Screen 2 forecast bands | Trained on silver and gold every run: departures-driven regression for apparel and travel goods, and level × week shape × last year without promotions × households away for fresh. **Monitorable:** backtest error 9.3% vs 13.6% for the spreadsheet (apparel 8% vs 22%). A drift monitor on travel bookings (×4.6) triggers the retrain. **Retrainable:** each run registers a new version (v1, v2, …) and archives the last. Surfaced in the dashboard and the decision workflow.                                                                                                 |
| **3 · GenAI on business knowledge** | Screen 2 e-mail panel                                         | Claude (`MODEL_SERVICE`, Unity AI Gateway) drafts from gold facts, the forecast and **clauses from supplier agreements and store playbooks** (`gold.knowledge_clauses`), citing clause IDs. Five checks run live as the planner edits: order lines match, no customer personal data, within terms, clauses cited, approval threshold. A template is the fallback if the model is unreachable.                                                                                                                                                                                        |
| **4 · Presentation layer**          | Both screens                                                  | Ingestion → prediction → generated output → human approval → write-back and audit trail, in one app.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## Architecture

- **AppKit** (`@databricks/appkit` 0.89) app: Express server + React (AppKit UI, Databricks brand theme from `exec-insight-console`, light/dark).
- **Lakebase** (`retail-demos` project): schema `replen_agent_hub`, created by the app's service principal on first start.
  - **Sources:** `src_pg_*` (managed Postgres), `src_lh_*` (lakehouse), `src_api_stock` and `src_api_customer` (raw JSON messages).
  - **Medallion:** `bronze_raw_events` → `silver_*` → `gold_*`.
  - **Model:** `ml_model_registry`, `ml_forecast`, `ml_backtest`.
  - **Agent:** `agent_signals`, `agent_recommendations`, `pipeline_runs`, `decision_log`, `outbox`.
- **Job tasks** (`server/app/pipeline.ts`, `model.ts`, `agent.ts`): `ingest → silver → gold → train → publish`. Each is a real API call, so the animation follows real work. In production the same steps are a Lakeflow job over Delta tables in Unity Catalog and an MLflow model; the panel shows that note under Governance.
- **Model service:** `workspace.ai_gateway.haiku55` (Claude Haiku 5.5), called on the gateway's Anthropic Messages path with thinking disabled.

## Deploy (same workspace as exec-insight-console)

```bash
databricks auth login --host https://<your-workspace>.cloud.databricks.com   # once
cd replenishment-agent-hub
databricks bundle validate
databricks bundle deploy          # creates the app with the postgres + model resources; lifecycle.started starts it
databricks bundle run app         # (re)deploys the source and starts the app
databricks apps get replenishment-agent-hub   # URL and status
```

- **First start:** the app creates `replen_agent_hub`, seeds the sources and runs the pipeline once, so Screen 2 has data. This takes a few seconds; see `/logz` if anything fails.
- **Same Lakebase project and model service as exec-insight-console:** both are bound in `databricks.yml`. If the model service has another name, change `model_service` there.
- **Optional:** set `DASHBOARD_URL` in `app.yaml` to make "Open in Databricks" on the dashboard node open a real AI/BI dashboard.
- **Reset before the interview:** the ↻ button in the header re-seeds the data, re-runs the pipeline and clears decisions.

## Running the demo (about 12 minutes of the 30-minute block)

1. **Screen 1, empty (1 min).** Say: "This is Harmoni's foundation before anything has run. The four systems you told me about are on the left." Name them: store POS and ordering on managed Postgres, ERP and history in the lakehouse, and two SaaS APIs. Then press **Run job**.
2. **While it runs (3 min).**
   - **Bronze:** "Everything lands raw, tagged with where it came from."
   - **Silver:** "This is where trust is earned." Point at the expectations: the replayed POS batch, the negative stock counts, and member e-mails dropped and IDs hashed.
   - **Gold:** "One record per product, store and day: the number the Monday meeting opens on."
   - **ML:** "Retrained on this run because travel bookings drifted. It beats the spreadsheet by a wide margin on apparel."
3. **Outputs (1 min).** "The same tables feed the dashboard and the agent. Nobody exports anything." Then click **Open Agent Decisions**.
4. **Signal 1 (4 min).**
   - Walk the chart: actuals, forecast band, stock hitting zero.
   - Give the **why**: customers buy jackets days before they fly. "The spreadsheet copies last year and under-orders by 47 units."
   - Compare the two options, then choose A. Show the draft: grounded on clauses, checks passing.
   - Edit a line, and show that the check flags it. Revert, then **Approve and send**.
   - Show the decision trail and the draft order waiting for Daniel's confirmation.
5. **Signal 2 (2 min).** Last year's line includes the promotion spike, and the order is the red line at 431 a day against a forecast of about 280. Recommend A or B. "One click for the planner, the store manager still confirms."
6. **Close.** "Ingestion to prediction to a governed action, with a person approving every write. Want to see where it would plug into your ordering system?"

**Persona hooks**

- **Business leader:** sales protected, waste avoided, store managers confirm.
- **CDO:** lineage, quarantine, masking, row filters, clause citations.
- **VP Engineering:** plain SQL and TypeScript, one Lakebase schema, model registry and versioning, the gateway, and no secrets in the app (resources bound in the bundle).

## Local development

`pnpm install`, then `pnpm run typecheck && pnpm run build`. The server needs a Lakebase connection (`.env.example`). Schema creation runs only in the deployed app (`DEMO_BOOTSTRAP=true` is in `app.yaml`, never `.env`).
