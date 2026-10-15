# Bambu Fleet Dashboard

One place for the whole Bambu Lab fleet: live printer status, print history, which parts were printed in
which material, and grams of filament per job **and per part**. Printers stay in normal **Bambu Cloud** mode,
so Bambu Handy and Studio remote printing keep working. The dashboard itself is reachable from anywhere
through Cloudflare Access.

```
Printers (cloud mode) ──MQTT 8883 (read) / FTPS 990 (read)──▶ LAN agent (Node 24, Docker)
                                                                │ outbound HTTPS only, SQLite outbox
                                                                ▼
                          Cloudflare Worker (Hono) + D1 + R2 + Durable Object "FleetLive"
                                                                ▲
                                  Browsers via Cloudflare Access (SSO), roles in D1
```

| Path | What it is |
|---|---|
| `packages/shared` | Types and zod schemas shared by agent and cloud (ingest API, live state, roles) |
| `packages/threemf` | Streaming `.gcode.3mf` parser: filament per plate and **grams per object** from G-code labels |
| `apps/agent` | LAN agent: reads each printer's local MQTT, tracks jobs, fetches the job 3MF over FTPS, forwards events |
| `apps/cloud` | Cloudflare Worker API + React dashboard (Fleet, History, Job, Parts, Materials, Admin) |

## Why it works this way

- **Fleet Hub / Farm Manager are not used.** Bambu's Fleet Hub white paper says Hub-bound printers run LAN-only
  and lose Handy/cloud access, and its API has no print history. Farm Manager has the same trade-off.
- **What Bambu allows in cloud mode:**
  - The agent only **reads** the printer's MQTT status feed (exempt from Authorization Control) and sends `pushall`.
  - It downloads the job file over FTPS.
  - It never sends control commands.
- **Per-part grams.** Bambu Studio wraps each object's G-code in `; start/stop printing object, unique label id: N`.
  The parser sums extrusion inside each label per filament, scales it to the slicer's `used_g`, and keeps purge and
  prime-tower extrusion as separate "waste".
- **Failed or cancelled jobs.** These count filament only up to the layer where they stopped, using a per-layer
  extrusion curve from the same parse.

## Local development

Requirements: Node ≥ 22.13 (24 recommended) and Corepack (`corepack enable`).

```bash
corepack pnpm install
```

```bash
corepack pnpm test
```

Run the dashboard locally (sign-in is replaced by `DEV_AUTH_EMAIL` on localhost):

```bash
cd apps/cloud && cp .dev.vars.example .dev.vars && corepack pnpm db:migrate:local && corepack pnpm db:seed:local && corepack pnpm dev
```

Replay a synthetic three-printer session into it. It contains a finished multi-part job, a failed job and a
cancelled job. Use the port Vite prints:

```bash
cd apps/agent && node scripts/make-demo-fixtures.ts && node src/main.ts replay fixtures/demo/session.jsonl --files fixtures/demo/files --cloud http://localhost:5173 --key dev-agent-key-0123456789
```

## Deploy the cloud side (Cloudflare)

1. **Create the database and bucket:**
   - `wrangler d1 create bambu-fleet`, then put the id in `apps/cloud/wrangler.jsonc`.
   - `wrangler r2 bucket create bambu-fleet-files`.
2. **Apply the schema:** `corepack pnpm --filter @fleet/cloud db:migrate:remote`.
3. **Set the vars** in `wrangler.jsonc`:
   - `BOOTSTRAP_ADMIN_EMAIL`: you.
   - `DEFAULT_ROLE`: `viewer`, or `none` to require invites.
4. **Deploy:** `corepack pnpm --filter @fleet/cloud deploy`.
5. **Put Cloudflare Access in front of the hostname** (Zero Trust → Access → Applications → Self-hosted):
   - Copy the team domain and the app's **AUD tag** into `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` and redeploy. The
     Worker verifies the Access JWT itself.
   - For `/ingest/*`, either add a **Bypass** policy for that path (the agent key still protects it) or issue an Access
     **service token** and put it in the agent's config.
6. **Create an agent:** sign in, go to Admin → Agents → Create agent, and copy the key (shown once).

Roles:

| Role | Can do |
|---|---|
| Viewer | Sees everything |
| Operator | Also renames and merges parts (and will dispatch jobs) |
| Admin | Also manages people and agents; every change is in the audit log |

## Run the agent next to the printers

Run it on any always-on machine on the printers' network: a Mac mini, Pi 5 or NAS. It needs to reach the printers
on 8883 and 990, plus outbound 443.

```bash
cd apps/agent && cp agent.example.yaml agent.yaml
```

1. **Fill in `agent.yaml`:**
   - The dashboard URL and agent key.
   - For each printer: serial, IP and LAN access code (all on the printer screen). Leave printers in cloud mode;
     **don't** enable LAN-only or Developer Mode.
2. **Prepare each printer for per-part data:**
   - Insert an SD card or USB stick.
   - On newer firmware, enable **"Store sent files on external storage"**.
   - Without this, jobs still appear with status and timing, but without filament or part data.
3. **Check access:**

   ```bash
   node src/main.ts probe
   ```

   It reports per printer whether MQTT answers and which `.3mf` files FTPS can see.
4. **Run it**, either directly:

   ```bash
   node src/main.ts run
   ```

   or with Docker (`docker compose up -d` in `apps/agent`).
5. **Keep one local MQTT client per printer.** Don't also run Home Assistant's Bambu integration in local mode
   against the same printers, because P1/A1 printers limit simultaneous connections.

Other agent commands:

- `node src/main.ts record --serial <sn> --out session.jsonl` captures a real printer's reports for replay and test
  fixtures.
- `node src/main.ts analyze file.gcode.3mf` prints a file's per-part breakdown.

## Verify on real hardware (Phase 0 spike)

The parser and job tracker are tested against synthetic data shaped after Bambu's formats. Confirm on one printer
of each model before relying on the numbers:

1. **Check access.** `agent probe` shows MQTT state and the 3MF files on storage.
2. **Record a print.** `agent record` a full print and a cancelled print from Studio. Keep the files as fixtures.
3. **Check the parts.** On a 2-object, 2-colour plate, the per-part grams on the Job page should add up (with waste)
   to Studio's estimate, and the part names should match the plate. This confirms the G-code `unique label id`
   equals `slice_info` `identify_id`.
4. **Check the cloud apps.** Handy still shows and controls the printer throughout.

## Not built yet

- **Cloud backfill (Phase 3).** Opt-in import of past jobs from Bambu's unofficial cloud task API. It is
  read-only, uses an honest User-Agent and is off by default, because of terms-of-service risk.
- **Assisted job queue (Phase 4).**
  - Upload a 3MF and parse it in the browser with `packages/threemf`.
  - Match jobs to printers by model and loaded AMS material.
  - An operator dispatches each one with one click through Bambu Connect.
  - The agent interfaces (`PrinterSource`, job file fetchers) leave room for a Fleet Hub "production cell" later.
