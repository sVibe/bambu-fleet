import {
  BUILTIN_TEMPLATES,
  exampleValues,
  LABEL_LIMITS,
  LABEL_SOURCES,
  type LabelElement,
  type LabelSource,
  type LabelTemplate,
  type LaidOutText,
  layoutLabel,
} from "@fleet/labels";
import { roleAtLeast } from "@fleet/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Link, useBlocker, useNavigate, useParams } from "react-router";
import type { LabelTemplateRow, PrintJobRow } from "../../api-types.ts";
import {
  api,
  fetchJobs,
  invalidate,
  useLabelTemplate,
  useLabelTemplates,
  useLabelValues,
  useMe,
  useParts,
  usePrintPrinters,
} from "../api.ts";
import { type Geometry, LabelCanvas, LabelSvg, useLabelFonts } from "../components/LabelCanvas.tsx";
import { ElementList, ElementProps, LabelSizeProps } from "../components/LabelProps.tsx";
import { printerLabel } from "../components/Print.tsx";
import {
  Badge,
  Button,
  Card,
  cx,
  ErrorState,
  inputClass,
  Loading,
  PageHeader,
  Select,
} from "../components/ui.tsx";
import { ago } from "../format.ts";

const SOURCE_TITLE: Record<LabelSource, string> = { part: "Part labels", job: "Job labels" };
const SOURCE_NOTE: Record<LabelSource, string> = {
  part: "Printed from a part's page.",
  job: "Printed from a job's page and for jobs picked in History; filled from the part the job printed most of.",
};

// --- Template list -------------------------------------------------------------------------------

export function LabelsPage() {
  const templates = useLabelTemplates();
  const me = useMe();
  const isAdmin = me.data?.role === "admin";
  const fonts = useLabelFonts();
  const [creating, setCreating] = useState<LabelSource | null>(null);

  return (
    <>
      <PageHeader
        title="Labels"
        subtitle="Label templates for parts and jobs. Each kind prints its default unless another is picked."
      />
      {templates.isLoading && <Loading />}
      {templates.error && <ErrorState error={templates.error} />}
      {templates.data && (
        <div className="space-y-8">
          {LABEL_SOURCES.map((source) => {
            const rows = templates.data.templates.filter((t) => t.source === source);
            return (
              <section key={source} className="space-y-3">
                <div className="flex flex-wrap items-end justify-between gap-2">
                  <div>
                    <h2 className="text-lg font-semibold">{SOURCE_TITLE[source]}</h2>
                    <p className="text-sm text-ink-2">{SOURCE_NOTE[source]}</p>
                  </div>
                  {isAdmin && (
                    <Button onClick={() => setCreating(creating === source ? null : source)}>
                      New template
                    </Button>
                  )}
                </div>
                {creating === source && (
                  <NewTemplate source={source} rows={rows} onCancel={() => setCreating(null)} />
                )}
                <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {rows.map((t) => (
                    <li key={t.id}>
                      <Link
                        to={`/labels/${encodeURIComponent(t.id)}`}
                        className="block rounded-xl border border-hairline bg-surface p-3 transition hover:bg-wash/60"
                      >
                        <div className="grid h-36 place-items-center rounded-lg bg-wash p-3">
                          <LabelSvg
                            template={t.template}
                            values={exampleValues(t.source)}
                            fonts={fonts}
                            title={`Preview of ${t.name}`}
                            className="max-h-full max-w-full shadow-sm"
                          />
                        </div>
                        <div className="mt-2 flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate font-medium">{t.name}</div>
                            <div className="text-xs text-muted">
                              {t.template.widthMm} × {t.template.heightMm} mm
                              {t.updatedAt ? ` · edited ${ago(t.updatedAt)}` : " · built in"}
                            </div>
                          </div>
                          {t.isDefault && <Badge tone="good">Default</Badge>}
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

function NewTemplate({
  source,
  rows,
  onCancel,
}: {
  source: LabelSource;
  rows: LabelTemplateRow[];
  onCancel: () => void;
}) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [from, setFrom] = useState<string>(BUILTIN_TEMPLATES[source].id);
  const create = useMutation({
    mutationFn: () => {
      const base = rows.find((r) => r.id === from)?.template;
      const template: LabelTemplate = base ?? { widthMm: 57, heightMm: 32, elements: [] };
      return api<LabelTemplateRow>("/api/print/templates", {
        method: "POST",
        json: { name: name.trim(), source, template },
      });
    },
    onSuccess: async (row) => {
      await invalidate(client, "label-templates");
      navigate(`/labels/${encodeURIComponent(row.id)}`);
    },
  });
  return (
    <Card className="p-4">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <label className="block min-w-48 flex-1 text-sm">
          <span className="text-ink-2">Name</span>
          <input
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            placeholder={source === "part" ? "e.g. Batch label 40×30" : "e.g. Job label"}
            className={`${inputClass} mt-1 w-full`}
            // biome-ignore lint/a11y/noAutofocus: the form opens on purpose to type a name
            autoFocus
          />
        </label>
        <label className="block text-sm">
          <span className="text-ink-2">Start from</span>
          <Select value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 block">
            {rows.map((r) => (
              <option key={r.id} value={r.id}>
                Copy of {r.name}
              </option>
            ))}
            <option value="">Empty 57 × 32 mm label</option>
          </Select>
        </label>
        <Button variant="primary" type="submit" disabled={!name.trim() || create.isPending}>
          {create.isPending ? "Creating…" : "Create and edit"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </form>
      {create.error && <p className="mt-2 text-sm text-critical">{create.error.message}</p>}
    </Card>
  );
}

// --- Undo history --------------------------------------------------------------------------------

interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

/**
 * A value with undo and redo. Changes with the same key within a second (typing in one field) are one
 * step; `record: false` replaces the value without a step (the rest of a drag).
 */
function useUndoable<T>(initial: T) {
  const ref = useRef<History<T>>({ past: [], present: initial, future: [] });
  const last = useRef<{ key: string; at: number } | null>(null);
  const [, render] = useReducer((n: number) => n + 1, 0);

  const set = useCallback((next: T, opts: { key?: string; record?: boolean } = {}) => {
    const h = ref.current;
    if (Object.is(next, h.present)) return;
    const now = Date.now();
    const same = opts.key !== undefined && last.current?.key === opts.key && now - last.current.at < 1000;
    const record = (opts.record ?? true) && !same;
    ref.current = { past: record ? [...h.past.slice(-99), h.present] : h.past, present: next, future: [] };
    last.current = opts.key ? { key: opts.key, at: now } : null;
    render();
  }, []);
  const undo = useCallback(() => {
    const h = ref.current;
    const prev = h.past.at(-1);
    if (prev === undefined) return;
    ref.current = { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] };
    last.current = null;
    render();
  }, []);
  const redo = useCallback(() => {
    const h = ref.current;
    const [next, ...rest] = h.future;
    if (next === undefined) return;
    ref.current = { past: [...h.past, h.present], present: next, future: rest };
    last.current = null;
    render();
  }, []);
  const reset = useCallback((value: T) => {
    ref.current = { past: [], present: value, future: [] };
    last.current = null;
    render();
  }, []);

  const h = ref.current;
  return {
    value: h.present,
    set,
    undo,
    redo,
    reset,
    canUndo: h.past.length > 0,
    canRedo: h.future.length > 0,
  };
}

// --- Editor --------------------------------------------------------------------------------------

interface Draft {
  name: string;
  template: LabelTemplate;
}

const newId = () => `el${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

function newElement(type: "text" | "qr" | "line" | "box", t: LabelTemplate): LabelElement {
  const id = newId();
  const room = (n: number, of: number) => Math.max(1, Math.min(n, of - 4));
  if (type === "text")
    return {
      id,
      type: "text",
      x: 2,
      y: 2,
      w: room(30, t.widthMm),
      h: 5,
      text: "Text",
      fontSize: 9,
      minFontSize: 6,
    };
  if (type === "qr") {
    const side = room(16, Math.min(t.widthMm, t.heightMm));
    return { id, type: "qr", x: 2, y: 2, w: side, h: side, value: "{{part.number}}" };
  }
  if (type === "line")
    return {
      id,
      type: "box",
      x: 2,
      y: Math.round(t.heightMm / 2),
      w: room(t.widthMm, t.widthMm),
      h: 0.3,
      fill: true,
    };
  return { id, type: "box", x: 2, y: 2, w: room(20, t.widthMm), h: room(10, t.heightMm), strokeMm: 0.3 };
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

export function LabelEditorPage() {
  const { id = "" } = useParams();
  const row = useLabelTemplate(id);
  if (row.isLoading) return <Loading />;
  if (row.error || !row.data) return <ErrorState error={row.error} />;
  // Remount for another template so no state carries over.
  return <Editor key={row.data.id} row={row.data} />;
}

function Editor({ row }: { row: LabelTemplateRow }) {
  const me = useMe();
  const client = useQueryClient();
  const navigate = useNavigate();
  const fonts = useLabelFonts();
  const isAdmin = me.data?.role === "admin";
  const canPrint = me.data ? roleAtLeast(me.data.role, "operator") : false;
  const readOnly = row.builtIn || !isAdmin;
  const source = row.source;

  const [saved, setSaved] = useState<{ draft: Draft; version: number }>({
    draft: { name: row.name, template: row.template },
    version: row.version,
  });
  const history = useUndoable<Draft>(saved.draft);
  const draft = history.value;
  const template = draft.template;
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(saved.draft), [draft, saved.draft]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snapOn, setSnapOn] = useState(true);
  const [outlines, setOutlines] = useState(true);
  const selected = template.elements.find((el) => el.id === selectedId) ?? null;

  // Data to draw the label with: example values, or a real part or job.
  const [dataId, setDataId] = useState<string>("");
  const realValues = useLabelValues(source, dataId || null);
  const values = useMemo(
    () => (dataId && realValues.data ? realValues.data.values : exampleValues(source)),
    [dataId, realValues.data, source],
  );
  const cut = useMemo(() => {
    if (!fonts || !selected || selected.type !== "text") return false;
    const [item] = layoutLabel({ ...template, elements: [selected] }, values, fonts);
    return Boolean(item && (item as LaidOutText).cut);
  }, [fonts, selected, template, values]);

  const setTemplate = (next: LabelTemplate, opts?: { key?: string; record?: boolean }) =>
    history.set({ ...draft, template: next }, opts);
  const setElements = (elements: LabelElement[], opts?: { key?: string; record?: boolean }) =>
    setTemplate({ ...template, elements }, opts);
  const patchElement = (
    elId: string,
    patch: Partial<LabelElement>,
    opts?: { key?: string; record?: boolean },
  ) =>
    setElements(
      template.elements.map((el) => (el.id === elId ? ({ ...el, ...patch } as LabelElement) : el)),
      opts,
    );
  const add = (type: "text" | "qr" | "line" | "box") => {
    if (template.elements.length >= LABEL_LIMITS.maxElements) return;
    const el = newElement(type, template);
    setElements([...template.elements, el]);
    setSelectedId(el.id);
  };
  const remove = (elId: string) => {
    setElements(template.elements.filter((el) => el.id !== elId));
    setSelectedId(null);
  };
  const duplicate = (elId: string) => {
    const el = template.elements.find((e) => e.id === elId);
    if (!el || template.elements.length >= LABEL_LIMITS.maxElements) return;
    const copy = { ...el, id: newId(), x: el.x + 2, y: el.y + 2 };
    const at = template.elements.indexOf(el) + 1;
    setElements([...template.elements.slice(0, at), copy, ...template.elements.slice(at)]);
    setSelectedId(copy.id);
  };
  const reorder = (elId: string, by: -1 | 1) => {
    const i = template.elements.findIndex((el) => el.id === elId);
    const j = i + by;
    if (i < 0 || j < 0 || j >= template.elements.length) return;
    const next = [...template.elements];
    [next[i], next[j]] = [next[j] as LabelElement, next[i] as LabelElement];
    setElements(next);
  };

  const save = useMutation({
    mutationFn: () =>
      api<LabelTemplateRow>(`/api/print/templates/${encodeURIComponent(row.id)}`, {
        method: "PUT",
        json: { name: draft.name.trim() || row.name, template, version: saved.version },
      }),
    onSuccess: (next) => {
      setSaved({ draft: { name: next.name, template: next.template }, version: next.version });
      history.set({ name: next.name, template: next.template }, { record: false });
      client.setQueryData(["label-templates", row.id], next);
      invalidate(client, "label-templates");
    },
  });
  const copy = useMutation({
    mutationFn: () =>
      api<LabelTemplateRow>("/api/print/templates", {
        method: "POST",
        json: { name: `Copy of ${draft.name}`.slice(0, 80), source, template },
      }),
    onSuccess: async (next) => {
      // The changes went into the copy; leave this one as it was saved.
      history.reset(saved.draft);
      await invalidate(client, "label-templates");
      navigate(`/labels/${encodeURIComponent(next.id)}`);
    },
  });
  const makeDefault = useMutation({
    mutationFn: () => api(`/api/print/templates/${encodeURIComponent(row.id)}/default`, { method: "PUT" }),
    onSuccess: () => invalidate(client, "label-templates", "print-printers"),
  });
  const deleteTemplate = useMutation({
    mutationFn: () => api(`/api/print/templates/${encodeURIComponent(row.id)}`, { method: "DELETE" }),
    onSuccess: async () => {
      history.reset(saved.draft);
      await invalidate(client, "label-templates", "print-printers");
      navigate("/labels");
    },
  });
  const templates = useLabelTemplates();
  const isDefault = templates.data?.templates.find((t) => t.id === row.id)?.isDefault ?? row.isDefault;

  // Leaving with unsaved changes asks first.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (window.confirm("Leave without saving your changes to this label?")) blocker.proceed();
    else blocker.reset();
  }, [blocker]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Keyboard: nudge, delete, duplicate, undo, save.
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keys.current = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (!readOnly && dirty && !save.isPending) save.mutate();
      return;
    }
    if (isTyping(e.target) || readOnly) return;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) history.redo();
      else history.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      history.redo();
      return;
    }
    if (!selected) return;
    if (mod && e.key.toLowerCase() === "d") {
      e.preventDefault();
      duplicate(selected.id);
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      remove(selected.id);
      return;
    }
    if (e.key === "Escape") {
      setSelectedId(null);
      return;
    }
    const step = e.shiftKey ? 1 : snapOn ? 0.5 : 0.1;
    const move: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const delta = move[e.key];
    if (!delta) return;
    e.preventDefault();
    patchElement(
      selected.id,
      {
        x: Math.round((selected.x + delta[0]) * 100) / 100,
        y: Math.round((selected.y + delta[1]) * 100) / 100,
      },
      { key: `${selected.id}.nudge` },
    );
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  return (
    <>
      <p className="mb-2 text-sm">
        <Link to="/labels" className="text-ink-2 hover:text-ink">
          ← Labels
        </Link>
      </p>
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          {readOnly ? (
            <h1 className="text-2xl font-semibold tracking-tight">{draft.name}</h1>
          ) : (
            <input
              value={draft.name}
              maxLength={80}
              onChange={(e) => history.set({ ...draft, name: e.target.value }, { key: "name" })}
              aria-label="Template name"
              className="w-full max-w-md rounded-lg border border-transparent bg-transparent px-1 text-2xl font-semibold tracking-tight hover:border-hairline focus:border-hairline focus:bg-raised focus:outline-none"
            />
          )}
          <div className="mt-1 flex flex-wrap items-center gap-2 px-1 text-sm text-ink-2">
            <span>
              {source === "part" ? "Part label" : "Job label"} · {template.widthMm} × {template.heightMm} mm
            </span>
            {isDefault && <Badge tone="good">Default</Badge>}
            {row.builtIn && <Badge tone="neutral">Built in</Badge>}
            {!row.builtIn && row.updatedBy && (
              <span className="text-muted">
                Saved {ago(row.updatedAt)} by {row.updatedBy}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!readOnly && (
            <>
              <Button variant="ghost" onClick={history.undo} disabled={!history.canUndo} title="Undo (⌘Z)">
                Undo
              </Button>
              <Button variant="ghost" onClick={history.redo} disabled={!history.canRedo} title="Redo (⇧⌘Z)">
                Redo
              </Button>
            </>
          )}
          {isAdmin && (
            <Button onClick={() => copy.mutate()} disabled={copy.isPending}>
              {row.builtIn ? "Copy to edit" : "Save as copy"}
            </Button>
          )}
          {isAdmin && !isDefault && (
            <Button onClick={() => makeDefault.mutate()} disabled={makeDefault.isPending || dirty}>
              Make default
            </Button>
          )}
          {!readOnly && (
            <Button variant="primary" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
              {save.isPending ? "Saving…" : dirty ? "Save" : "Saved"}
            </Button>
          )}
        </div>
      </header>
      {[save.error, copy.error, makeDefault.error, deleteTemplate.error].map(
        (err) =>
          err && (
            <p key={err.message} className="mb-3 text-sm text-critical">
              {err.message}
            </p>
          ),
      )}
      {row.builtIn && isAdmin && (
        <p className="mb-3 text-sm text-ink-2">
          Built-in labels can't be changed. Copy this one to make your own, then make that the default.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {!readOnly && (
              <div className="flex flex-wrap gap-1">
                <Button onClick={() => add("text")}>+ Text</Button>
                <Button onClick={() => add("qr")}>+ QR code</Button>
                <Button onClick={() => add("line")}>+ Line</Button>
                <Button onClick={() => add("box")}>+ Box</Button>
              </div>
            )}
            <span className="flex-1" />
            {!readOnly && (
              <label className="flex items-center gap-1.5 text-sm text-ink-2">
                <input
                  type="checkbox"
                  checked={snapOn}
                  onChange={(e) => setSnapOn(e.target.checked)}
                  className="size-4 accent-accent"
                />
                Snap to 0.5 mm
              </label>
            )}
            <label className="flex items-center gap-1.5 text-sm text-ink-2">
              <input
                type="checkbox"
                checked={outlines}
                onChange={(e) => setOutlines(e.target.checked)}
                className="size-4 accent-accent"
              />
              Outlines
            </label>
          </div>

          <Card className="grid place-items-center bg-wash p-4 sm:p-6">
            <LabelCanvas
              template={template}
              values={values}
              fonts={fonts}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onMove={(elId: string, g: Geometry, first: boolean) => patchElement(elId, g, { record: first })}
              readOnly={readOnly}
              snapMm={snapOn ? 0.5 : 0.1}
              outlines={outlines}
            />
          </Card>

          <DataPicker source={source} value={dataId} onChange={setDataId} loading={realValues.isFetching} />
          {realValues.error && <p className="text-sm text-critical">{realValues.error.message}</p>}
          {!readOnly && (
            <p className="text-xs text-muted">
              Drag to move, drag a corner to resize. Arrow keys nudge (Shift: 1 mm), ⌫ deletes, ⌘D duplicates,
              ⌘Z undoes, ⌘S saves.
            </p>
          )}
          <PrintTools source={source} template={template} dataId={dataId} canPrint={canPrint} />
        </div>

        <aside className="min-w-0 space-y-4">
          <Card className="p-4">
            {selected ? (
              <ElementProps
                key={selected.id}
                el={selected}
                label={template}
                source={source}
                values={values}
                cut={cut}
                readOnly={readOnly}
                onChange={(patch, key) => patchElement(selected.id, patch, { key })}
                onDelete={() => remove(selected.id)}
                onDuplicate={() => duplicate(selected.id)}
              />
            ) : (
              <LabelSizeProps
                template={template}
                readOnly={readOnly}
                onChange={(next, key) => setTemplate(next, { key })}
              />
            )}
          </Card>
          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-semibold">Elements</h2>
              {selected && (
                <Button variant="ghost" onClick={() => setSelectedId(null)}>
                  Label size
                </Button>
              )}
            </div>
            <ElementList
              elements={template.elements}
              selectedId={selectedId}
              readOnly={readOnly}
              onSelect={setSelectedId}
              onMove={reorder}
            />
          </Card>
          {isAdmin && !row.builtIn && (
            <Button
              variant="danger"
              onClick={() => {
                if (window.confirm(`Delete “${row.name}”? Labels already printed stay in the print history.`))
                  deleteTemplate.mutate();
              }}
              disabled={deleteTemplate.isPending}
            >
              Delete template
            </Button>
          )}
        </aside>
      </div>
    </>
  );
}

/** Pick what the canvas and previews show: example values, or a real part or recent job. */
function DataPicker({
  source,
  value,
  onChange,
  loading,
}: {
  source: LabelSource;
  value: string;
  onChange: (id: string) => void;
  loading: boolean;
}) {
  const parts = useParts("");
  const jobs = useQuery({
    queryKey: ["jobs", "label-data"],
    queryFn: () => fetchJobs({}, null),
    enabled: source === "job",
  });
  const options =
    source === "part"
      ? (parts.data ?? []).map((p) => ({ id: p.id, label: p.name }))
      : (jobs.data?.items ?? []).map((j) => ({ id: j.id, label: `${j.name} · ${j.printerName}` }));
  return (
    <label className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-ink-2">Show with</span>
      <Select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-0 max-w-full flex-1 sm:flex-none"
      >
        <option value="">Example values</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </Select>
      {loading && <span className="text-xs text-muted">Loading…</span>}
    </label>
  );
}

/** The label as a PDF, and a test print on the label printer, of the label as it is now (saved or not). */
function PrintTools({
  source,
  template,
  dataId,
  canPrint,
}: {
  source: LabelSource;
  template: LabelTemplate;
  dataId: string;
  canPrint: boolean;
}) {
  const printers = usePrintPrinters();
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  useEffect(
    () => () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    },
    [pdfUrl],
  );
  const body = dataId
    ? {
        kind: source === "part" ? "part-label" : "job-label",
        [source === "part" ? "partId" : "jobId"]: dataId,
        template,
      }
    : { kind: "test-label", source, template };

  const preview = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/print/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        credentials: "same-origin",
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(err?.error ?? `${res.status} ${res.statusText}`);
      }
      return URL.createObjectURL(await res.blob());
    },
    onSuccess: setPdfUrl,
  });
  const print = useMutation({
    mutationFn: () => api<PrintJobRow>("/api/print/jobs", { method: "POST", json: body }),
  });
  const labelPrinter = printers.data?.printers.find((p) => p.id === printers.data?.labelPrinterId);
  const printReady = canPrint && printers.data?.configured && labelPrinter;

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => preview.mutate()} disabled={preview.isPending}>
          {preview.isPending ? "Making PDF…" : pdfUrl ? "Refresh PDF" : "Preview as PDF"}
        </Button>
        {canPrint && (
          <Button
            onClick={() => print.mutate()}
            disabled={!printReady || print.isPending}
            title={printReady ? undefined : "Choose a label printer under Admin → Printing first"}
          >
            {print.isPending
              ? "Sending…"
              : labelPrinter
                ? `Test print on ${printerLabel(labelPrinter)}`
                : "Test print"}
          </Button>
        )}
        {print.data && (
          <span className={cx("text-sm", print.data.state === "failed" ? "text-critical" : "text-ink-2")}>
            {print.data.state === "failed" ? print.data.message : "Sent to PrintNode."}
          </span>
        )}
        {pdfUrl && (
          <a href={pdfUrl} target="_blank" rel="noreferrer" className="text-sm text-ink-2 hover:underline">
            Open the PDF
          </a>
        )}
      </div>
      {(preview.error || print.error) && (
        <p className="text-sm text-critical">{(preview.error ?? print.error)?.message}</p>
      )}
      {pdfUrl && (
        <iframe
          title="Label PDF"
          src={`${pdfUrl}#toolbar=0&navpanes=0&view=Fit`}
          style={{ aspectRatio: `${template.widthMm} / ${template.heightMm}` }}
          className="w-full max-w-xl rounded-md border border-hairline bg-white"
        />
      )}
    </Card>
  );
}
