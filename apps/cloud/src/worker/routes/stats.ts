import { Hono } from "hono";
import type { StatsBucket, StatsResponse } from "../../api-types.ts";
import type { AppEnv } from "../env.ts";
import { optionalInt, round } from "../util.ts";

export const stats = new Hono<AppEnv>();

const BUCKET_FORMAT: Record<StatsBucket, string> = { day: "%Y-%m-%d", week: "%Y-W%W", month: "%Y-%m" };

/**
 * Grams a job actually consumed: the analysis-based estimate when present, else the slicer total
 * for finished jobs. Per-filament grams are scaled by the same ratio.
 */
const CONSUMED = "COALESCE(j.actual_weight_g, CASE WHEN j.status = 'finished' THEN j.est_weight_g END, 0)";
const FILAMENT_SCALE = `COALESCE(j.actual_weight_g / NULLIF(j.est_weight_g, 0), CASE WHEN j.status = 'finished' THEN 1 ELSE 0 END)`;

stats.get("/stats", async (c) => {
  const now = Date.now();
  const to = optionalInt(c.req.query("to")) ?? now;
  const from = optionalInt(c.req.query("from")) ?? to - 30 * 24 * 3600 * 1000;
  const bucketParam = c.req.query("bucket");
  const bucket: StatsBucket = bucketParam === "week" || bucketParam === "month" ? bucketParam : "day";
  const db = c.env.DB;
  const range = "j.started_at >= ? AND j.started_at < ?";

  const [totals, byPeriod, byPrinter, byColor, topParts] = await db.batch([
    db
      .prepare(
        `SELECT COUNT(*) AS jobs,
           SUM(j.status = 'finished') AS finished, SUM(j.status = 'failed') AS failed,
           SUM(j.status = 'cancelled') AS cancelled, SUM(j.status = 'printing') AS printing,
           SUM(${CONSUMED}) AS grams,
           SUM(CASE WHEN j.status = 'finished' THEN COALESCE(j.waste_g, 0) ELSE 0 END) AS waste_g,
           SUM(COALESCE(j.duration_s, 0)) / 3600.0 AS hours
         FROM jobs j WHERE ${range}`,
      )
      .bind(from, to),
    db
      .prepare(
        `SELECT strftime(?, j.started_at / 1000, 'unixepoch') AS period, COALESCE(f.material, 'Unknown') AS material,
           SUM(f.weight_g * ${FILAMENT_SCALE}) AS grams
         FROM jobs j JOIN job_filaments f ON f.job_id = j.id
         WHERE ${range} GROUP BY period, material HAVING grams > 0 ORDER BY period, material`,
      )
      .bind(BUCKET_FORMAT[bucket], from, to),
    db
      .prepare(
        `SELECT p.serial, p.name, COUNT(j.id) AS jobs,
           COALESCE(SUM(j.status = 'finished'), 0) AS finished, COALESCE(SUM(j.status = 'failed'), 0) AS failed,
           COALESCE(SUM(${CONSUMED}), 0) AS grams, COALESCE(SUM(j.duration_s), 0) / 3600.0 AS hours
         FROM printers p LEFT JOIN jobs j ON j.printer_serial = p.serial AND ${range}
         WHERE p.archived = 0 GROUP BY p.serial ORDER BY p.name`,
      )
      .bind(from, to),
    db
      .prepare(
        `SELECT COALESCE(f.material, 'Unknown') AS material, f.color, SUM(f.weight_g * ${FILAMENT_SCALE}) AS grams
         FROM jobs j JOIN job_filaments f ON f.job_id = j.id
         WHERE ${range} GROUP BY material, f.color HAVING grams > 0 ORDER BY grams DESC LIMIT 16`,
      )
      .bind(from, to),
    db
      .prepare(
        `SELECT pt.id, pt.name, COUNT(*) AS qty, COALESCE(SUM(jp.weight_g), 0) AS grams
         FROM job_parts jp JOIN jobs j ON j.id = jp.job_id JOIN parts pt ON pt.id = jp.part_id
         WHERE ${range} AND j.status = 'finished' AND jp.skipped = 0
         GROUP BY pt.id ORDER BY qty DESC, grams DESC LIMIT 10`,
      )
      .bind(from, to),
  ]);

  const t = (totals?.results[0] ?? {}) as Record<string, number | null>;
  const finished = t.finished ?? 0;
  const failed = t.failed ?? 0;
  const body: StatsResponse = {
    range: { from, to, bucket },
    totals: {
      jobs: t.jobs ?? 0,
      finished,
      failed,
      cancelled: t.cancelled ?? 0,
      printing: t.printing ?? 0,
      grams: round(t.grams),
      wasteG: round(t.waste_g),
      printHours: round(t.hours),
      successRate: finished + failed > 0 ? finished / (finished + failed) : null,
    },
    byPeriod: ((byPeriod?.results ?? []) as Array<Record<string, unknown>>).map((r) => ({
      period: r.period as string,
      material: r.material as string,
      grams: round(r.grams as number),
    })),
    byPrinter: ((byPrinter?.results ?? []) as Array<Record<string, unknown>>).map((r) => ({
      serial: r.serial as string,
      name: r.name as string,
      jobs: r.jobs as number,
      finished: r.finished as number,
      failed: r.failed as number,
      grams: round(r.grams as number),
      hours: round(r.hours as number),
    })),
    byColor: ((byColor?.results ?? []) as Array<Record<string, unknown>>).map((r) => ({
      material: r.material as string,
      color: r.color as string | null,
      grams: round(r.grams as number),
    })),
    topParts: ((topParts?.results ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      qty: r.qty as number,
      grams: round(r.grams as number),
    })),
  };
  return c.json(body);
});
