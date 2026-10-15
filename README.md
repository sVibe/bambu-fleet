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
| `apps/cloud` | Cloudflare Worker API + React dashboard (Fleet, Queue, History, Job, Parts, Materials, Admin) |

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

To try the queue, open **Queue**, upload `apps/agent/fixtures/demo/files/Bracket set.gcode.3mf` and dispatch it to
P1S-01. Then run the same replay command again: P1S-01 starts a job named "Bracket set", and the item moves to
printing and then to done. Add `--speed 20` to the replay to make it quicker.

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
| Operator | Also renames and merges parts, and uploads, queues and dispatches jobs |
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
5. **Check the queue match.** Dispatch a queued file and start it from Bambu Connect.
   - The job name the printer reports should match the file name, so the queue item moves to printing.
   - The file's `printer_model_id` should map to the printer's model, not to "check manually".

## Assisted job queue

The **Queue** page plans prints across the fleet. Starting each print stays a human step in Bambu Connect.

1. **Upload.** An operator uploads a sliced `.gcode.3mf` (in Bambu Studio: File → Export → Export plate sliced
   file).
   - The browser parses it with `packages/threemf` in a Web Worker and shows each plate's filaments, parts, grams,
     time and `printer_model_id`.
   - In the same pass it computes the file's MD5. Web Crypto has no MD5, so `packages/shared` has a small one.
   - The file is stored in R2 as `queue/<md5>.gcode.3mf`. R2 checks the MD5 on upload, and a file that's already
     stored isn't sent again.
   - Uploads are limited to 100 MB, the Workers request-body limit on the Free and Pro plans.
2. **Queue.** Each selected plate becomes a queue item with a title, number of copies and priority.
3. **Match.** Every open item ranks the printers using the live state from the FleetLive Durable Object:
   - **Model:** the 3MF's `printer_model_id` is compared with the printer's model. The mapping table is in
     `packages/shared/src/queue.ts`. An id or model that isn't in the table shows as "check manually".
   - **Materials:** each filament needs a loaded AMS tray (or external spool) of the same material. The closest
     colour wins, and the suggested slot mapping (A1–A4, B1…, Ext) is shown so it can be picked in Bambu Connect.
   - **State:** IDLE is ready. FINISH or FAILED means the bed has to be cleared first. A printer that's busy or
     already has an item dispatched to it is marked busy, and an offline printer is unsuitable.
4. **Dispatch.** *Dispatch* records the hand-off and downloads the file.
   - The page also offers a `bambu-connect://import-file?path=…&name=…&version=1.0.0` link.
   - Bambu Connect only imports from a **local file path**, which a web page can't know. The link is therefore built
     from the downloads folder the operator types in once (it's kept in the browser).
   - Without that folder, the fallback is: **download, then open the file in Bambu Connect or Bambu Studio**.
   - Printers stay in cloud mode, so third-party software can't start prints. The dashboard never sends MQTT print
     commands.
5. **Reconcile.** When the agent reports `job.started` on the item's printer, the cloud links the job to the
   dispatched item.
   - It matches when the job name equals the item's file name or title (case-insensitive, without `.gcode.3mf`)
     and the job started within 2 hours of dispatch.
   - The item moves to printing. On `job.ended` it moves to done, or to failed if the job failed or was cancelled.
   - With more than one copy, a finished run puts the item back in the queue until all copies are printed.
   - Items that never link (for example, after the job was renamed in Studio) can be requeued or cancelled.

Everyone can see the queue. Uploading, queueing, dispatching and downloading files need the operator role, and each
change is written to the audit log.

## Not built yet

- **Cloud backfill (Phase 3).** Opt-in import of past jobs from Bambu's unofficial cloud task API. It is
  read-only, uses an honest User-Agent and is off by default, because of terms-of-service risk.
- **Fleet Hub "production cell".** The agent interfaces (`PrinterSource`, job file fetchers) leave room for
  printers that are moved to Fleet Hub later, which could start queued jobs without a human step.
