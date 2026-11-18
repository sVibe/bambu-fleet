import {
  BUILTIN_TEMPLATES,
  LABEL_LIMITS,
  LABEL_SOURCES,
  type LabelElement,
  type LabelSource,
  type LabelTemplate,
} from "@fleet/labels";
import { z } from "zod";
import type { LabelTemplateRow } from "../api-types.ts";
import { getSetting } from "./printing.ts";
import { parseJson } from "./util.ts";

export const defaultTemplateKey = (source: LabelSource) => `print.default_template.${source}`;

const L = LABEL_LIMITS;
/** Positions may reach a little past the label, so an element can be dragged half off it. */
const position = z
  .number()
  .finite()
  .min(-L.maxHeightMm)
  .max(2 * L.maxHeightMm);
const length = z.number().finite().min(0).max(L.maxHeightMm);
const fontPt = z.number().finite().min(L.minFontPt).max(L.maxFontPt);
const base = { id: z.string().min(1).max(40), x: position, y: position, w: length, h: length };

const element = z.discriminatedUnion("type", [
  z.object({
    ...base,
    type: z.literal("text"),
    text: z.string().max(L.maxTextLength),
    fontSize: fontPt,
    minFontSize: fontPt.optional(),
    bold: z.boolean().optional(),
    align: z.enum(["left", "center", "right"]).optional(),
    maxLines: z.number().int().min(1).max(50).optional(),
  }),
  z.object({ ...base, type: z.literal("qr"), value: z.string().max(L.maxTextLength) }),
  z.object({
    ...base,
    type: z.literal("box"),
    fill: z.boolean().optional(),
    strokeMm: z.number().finite().min(0.1).max(5).optional(),
  }),
]);

/** A template as the editor sends it; unknown fields are dropped. */
export const labelTemplateSchema = z.object({
  widthMm: z.number().finite().min(L.minSizeMm).max(L.maxWidthMm),
  heightMm: z.number().finite().min(L.minSizeMm).max(L.maxHeightMm),
  elements: z.array(element).max(L.maxElements),
}) satisfies z.ZodType<LabelTemplate>;

export const labelSourceSchema = z.enum(LABEL_SOURCES as [LabelSource, ...LabelSource[]]);

export interface TemplateDbRow {
  id: string;
  name: string;
  source: LabelSource;
  width_mm: number;
  height_mm: number;
  elements: string;
  version: number;
  updated_by: string;
  updated_at: number;
}

export function toTemplateRow(r: TemplateDbRow, defaultId: string | null): LabelTemplateRow {
  return {
    id: r.id,
    name: r.name,
    source: r.source,
    builtIn: false,
    isDefault: r.id === defaultId,
    template: {
      widthMm: r.width_mm,
      heightMm: r.height_mm,
      elements: parseJson<LabelElement[]>(r.elements, []),
    },
    version: r.version,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  };
}

function builtinRow(source: LabelSource, defaultId: string | null): LabelTemplateRow {
  const b = BUILTIN_TEMPLATES[source];
  return {
    id: b.id,
    name: b.name,
    source,
    builtIn: true,
    // The built-in label prints unless another template was made the default.
    isDefault: defaultId === null || defaultId === b.id,
    template: b.template,
    version: 0,
    updatedBy: null,
    updatedAt: null,
  };
}

const builtinById = (id: string) => LABEL_SOURCES.find((s) => BUILTIN_TEMPLATES[s].id === id);

/** The default template's id per kind, or null where the built-in one prints. */
async function defaultIds(db: D1Database): Promise<Record<LabelSource, string | null>> {
  const [part, job] = await Promise.all(LABEL_SOURCES.map((s) => getSetting(db, defaultTemplateKey(s))));
  return { part: part ?? null, job: job ?? null };
}

/** Every template, built-in ones first, then by kind and name. */
export async function listTemplates(db: D1Database): Promise<LabelTemplateRow[]> {
  const [rows, defaults] = await Promise.all([
    db
      .prepare("SELECT * FROM label_templates WHERE deleted_at IS NULL ORDER BY source, name COLLATE NOCASE")
      .all<TemplateDbRow>(),
    defaultIds(db),
  ]);
  // A default that was deleted falls back to the built-in label.
  const live = new Set(rows.results.map((r) => r.id));
  const effective = (s: LabelSource) => {
    const id = defaults[s];
    return id && (live.has(id) || builtinById(id)) ? id : null;
  };
  return [
    ...LABEL_SOURCES.map((s) => builtinRow(s, effective(s))),
    ...rows.results.map((r) => toTemplateRow(r, effective(r.source))),
  ];
}

export async function loadTemplate(db: D1Database, id: string): Promise<LabelTemplateRow | null> {
  const builtin = builtinById(id);
  const defaults = await defaultIds(db);
  if (builtin) return builtinRow(builtin, defaults[builtin]);
  const row = await db
    .prepare("SELECT * FROM label_templates WHERE id = ? AND deleted_at IS NULL")
    .bind(id)
    .first<TemplateDbRow>();
  return row ? toTemplateRow(row, defaults[row.source]) : null;
}

/** The template a print uses: the one asked for, else the kind's default, else the built-in label. */
export async function resolveTemplate(
  db: D1Database,
  id: string | undefined,
  source: LabelSource,
): Promise<LabelTemplateRow | null> {
  if (id) return loadTemplate(db, id);
  const chosen = await getSetting(db, defaultTemplateKey(source));
  const row = chosen ? await loadTemplate(db, chosen) : null;
  return row && row.source === source ? row : builtinRow(source, null);
}
