import type { JobStatus } from "@fleet/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { PartDetail, PartListItem } from "../../api-types.ts";
import { audit, requireRole } from "../auth.ts";
import type { AppEnv } from "../env.ts";

export const parts = new Hono<AppEnv>();

const PART_STATS = `
  SELECT pt.id, pt.name,
    COUNT(CASE WHEN j.status = 'finished' AND jp.skipped = 0 THEN 1 END) AS printed_qty,
    COUNT(CASE WHEN j.status IN ('failed', 'cancelled') AND jp.skipped = 0 THEN 1 END) AS failed_qty,
    COUNT(DISTINCT jp.job_id) AS jobs,
    SUM(CASE WHEN j.status = 'finished' AND jp.skipped = 0 THEN jp.weight_g END) AS total_g,
    SUM(CASE WHEN j.status = 'finished' AND jp.skipped = 0 THEN jp.waste_share_g END) AS waste_g,
    MAX(CASE WHEN j.status = 'finished' THEN j.ended_at END) AS last_printed_at,
    (SELECT group_concat(DISTINCT jf.material)
       FROM job_parts jp2, json_each(jp2.per_filament) je
       JOIN job_filaments jf ON jf.job_id = jp2.job_id AND jf.idx = CAST(je.key AS INTEGER)
      WHERE jp2.part_id = pt.id) AS materials
  FROM parts pt
  LEFT JOIN job_parts jp ON jp.part_id = pt.id
  LEFT JOIN jobs j ON j.id = jp.job_id`;

interface PartStatsRow {
  id: string;
  name: string;
  printed_qty: number;
  failed_qty: number;
  jobs: number;
  total_g: number | null;
  waste_g: number | null;
  last_printed_at: number | null;
  materials: string | null;
}

/**
 * Each finished, non-skipped part instance counts once, under the filament that supplied most of
 * its grams. Rows: per part, per dominant material and colour, the number of instances.
 */
const DOMINANT_FILAMENT = `
  WITH inst AS (
    SELECT jp.part_id, jf.material, jf.color,
      ROW_NUMBER() OVER (PARTITION BY jp.job_id, jp.identify_id ORDER BY je.value DESC) AS rn
    FROM job_parts jp JOIN jobs j ON j.id = jp.job_id, json_each(jp.per_filament) je
    JOIN job_filaments jf ON jf.job_id = jp.job_id AND jf.idx = CAST(je.key AS INTEGER)
    WHERE j.status = 'finished' AND jp.skipped = 0 AND je.value > 0 %FILTER%
  )
  SELECT part_id, COALESCE(material, 'Unknown') AS material, color, COUNT(*) AS n
  FROM inst WHERE rn = 1 GROUP BY part_id, material, color`;

type TopFilament = NonNullable<PartListItem["topFilament"]>;

/** Most used material per part (by instances printed), with its most common colour. */
export function topFilaments(
  rows: Array<{ part_id: string; material: string; color: string | null; n: number }>,
) {
  const byPart = new Map<string, Map<string, { n: number; colors: Map<string | null, number> }>>();
  for (const r of rows) {
    const materials = byPart.get(r.part_id) ?? new Map();
    byPart.set(r.part_id, materials);
    const m = materials.get(r.material) ?? { n: 0, colors: new Map() };
    materials.set(r.material, m);
    m.n += r.n;
    m.colors.set(r.color, (m.colors.get(r.color) ?? 0) + r.n);
  }
  const out = new Map<string, TopFilament>();
  for (const [partId, materials] of byPart) {
    const total = [...materials.values()].reduce((n, m) => n + m.n, 0);
    const [material, top] = [...materials.entries()].sort(
      (a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]),
    )[0] as [string, { n: number; colors: Map<string | null, number> }];
    const color = [...top.colors.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    out.set(partId, { material, color, count: top.n, share: top.n / total });
  }
  return out;
}

function toItem(r: PartStatsRow, top: TopFilament | null = null): PartListItem {
  return {
    id: r.id,
    name: r.name,
    printedQty: r.printed_qty,
    failedQty: r.failed_qty,
    jobs: r.jobs,
    totalG: r.total_g,
    avgG: r.total_g !== null && r.printed_qty > 0 ? r.total_g / r.printed_qty : null,
    wasteG: r.waste_g,
    lastPrintedAt: r.last_printed_at,
    materials: r.materials ? [...new Set(r.materials.split(","))].sort() : [],
    topFilament: top,
  };
}

parts.get("/parts", async (c) => {
  const q = c.req.query("q");
  const db = c.env.DB;
  const [rows, dominant] = await db.batch([
    db
      .prepare(
        `${PART_STATS} WHERE pt.merged_into IS NULL ${q ? "AND pt.name LIKE ?" : ""}
         GROUP BY pt.id ORDER BY printed_qty DESC, pt.name LIMIT 1000`,
      )
      .bind(...(q ? [`%${q}%`] : [])),
    db.prepare(DOMINANT_FILAMENT.replace("%FILTER%", "")),
  ]);
  const top = topFilaments((dominant?.results ?? []) as Parameters<typeof topFilaments>[0]);
  return c.json(((rows?.results ?? []) as PartStatsRow[]).map((r) => toItem(r, top.get(r.id) ?? null)));
});

parts.get("/parts/:id", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const part = await db
    .prepare("SELECT id, name, notes, created_at, merged_into FROM parts WHERE id = ?")
    .bind(id)
    .first<{
      id: string;
      name: string;
      notes: string | null;
      created_at: number;
      merged_into: string | null;
    }>();
  if (!part) return c.json({ error: "Part not found" }, 404);
  if (part.merged_into) return c.json({ mergedInto: part.merged_into }, 409);

  const [stats, materials, history, dominant] = await db.batch([
    db.prepare(`${PART_STATS} WHERE pt.id = ? GROUP BY pt.id`).bind(id),
    db
      .prepare(
        `SELECT jf.material, jf.color, SUM(je.value) AS grams
         FROM job_parts jp JOIN jobs j ON j.id = jp.job_id, json_each(jp.per_filament) je
         JOIN job_filaments jf ON jf.job_id = jp.job_id AND jf.idx = CAST(je.key AS INTEGER)
         WHERE jp.part_id = ? AND j.status = 'finished' AND jp.skipped = 0
         GROUP BY jf.material, jf.color ORDER BY grams DESC`,
      )
      .bind(id),
    db
      .prepare(
        `SELECT j.id AS job_id, j.name AS job_name, p.name AS printer_name, j.status, j.started_at,
           COUNT(*) AS qty, SUM(jp.skipped) AS skipped, SUM(CASE WHEN jp.skipped = 0 THEN jp.weight_g END) AS grams
         FROM job_parts jp JOIN jobs j ON j.id = jp.job_id JOIN printers p ON p.serial = j.printer_serial
         WHERE jp.part_id = ? GROUP BY j.id ORDER BY j.started_at DESC LIMIT 200`,
      )
      .bind(id),
    db.prepare(DOMINANT_FILAMENT.replace("%FILTER%", "AND jp.part_id = ?")).bind(id),
  ]);
  const top = topFilaments((dominant?.results ?? []) as Parameters<typeof topFilaments>[0]).get(id) ?? null;

  const body: PartDetail = {
    part: { id: part.id, name: part.name, notes: part.notes, createdAt: part.created_at },
    stats: toItem(
      (stats?.results[0] as PartStatsRow | undefined) ??
        ({
          ...part,
          printed_qty: 0,
          failed_qty: 0,
          jobs: 0,
          total_g: null,
          waste_g: null,
          last_printed_at: null,
          materials: null,
        } as PartStatsRow),
      top,
    ),
    materials: ((materials?.results ?? []) as Array<Record<string, unknown>>).map((r) => ({
      material: r.material as string | null,
      color: r.color as string | null,
      grams: r.grams as number,
    })),
    history: ((history?.results ?? []) as Array<Record<string, unknown>>).map((r) => ({
      jobId: r.job_id as string,
      jobName: r.job_name as string,
      printerName: r.printer_name as string,
      status: r.status as JobStatus,
      startedAt: r.started_at as number,
      qty: r.qty as number,
      skipped: r.skipped as number,
      grams: r.grams as number | null,
    })),
  };
  return c.json(body);
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  notes: z.string().max(2000).nullable().optional(),
});

parts.patch("/parts/:id", requireRole("operator"), async (c) => {
  const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid part update" }, 400);
  const id = c.req.param("id");
  const { name, notes } = parsed.data;
  const res = await c.env.DB.prepare(
    "UPDATE parts SET name = COALESCE(?, name), notes = CASE WHEN ? THEN ? ELSE notes END WHERE id = ? AND merged_into IS NULL",
  )
    .bind(name ?? null, notes !== undefined ? 1 : 0, notes ?? null, id)
    .run();
  if (res.meta.changes === 0) return c.json({ error: "Part not found" }, 404);
  await audit(c, "part.update", "part", id, parsed.data);
  return c.json({ ok: true });
});

parts.post("/parts/:id/merge", requireRole("operator"), async (c) => {
  const parsed = z.object({ intoId: z.string().min(1) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "intoId required" }, 400);
  const id = c.req.param("id");
  const into = parsed.data.intoId;
  if (id === into) return c.json({ error: "Cannot merge a part into itself" }, 400);
  const db = c.env.DB;
  const target = await db
    .prepare("SELECT id FROM parts WHERE id = ? AND merged_into IS NULL")
    .bind(into)
    .first();
  const source = await db
    .prepare("SELECT id FROM parts WHERE id = ? AND merged_into IS NULL")
    .bind(id)
    .first();
  if (!target || !source) return c.json({ error: "Part not found" }, 404);
  await db.batch([
    db.prepare("UPDATE job_parts SET part_id = ? WHERE part_id = ?").bind(into, id),
    // Earlier merges into the source follow it to the new target, so lookups stay one level deep.
    db.prepare("UPDATE parts SET merged_into = ? WHERE id = ? OR merged_into = ?").bind(into, id, id),
  ]);
  await audit(c, "part.merge", "part", id, { into });
  return c.json({ ok: true });
});
