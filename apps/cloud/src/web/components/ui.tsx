import type { GcodeState, JobStatus } from "@fleet/shared";
import type { ButtonHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import type { FilamentChip } from "../../api-types.ts";
import { ApiError } from "../api.ts";
import { grams, hex } from "../format.ts";

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-xl border border-hairline bg-surface", className)}>{children}</section>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

type Tone = "good" | "warning" | "serious" | "critical" | "accent" | "neutral";

const TONE_DOT: Record<Tone, string> = {
  good: "bg-good",
  warning: "bg-warning",
  serious: "bg-serious",
  critical: "bg-critical",
  accent: "bg-accent",
  neutral: "bg-muted",
};

const TONE_ICON: Record<Tone, string> = {
  good: "✓",
  warning: "!",
  serious: "!",
  critical: "✕",
  accent: "▶",
  neutral: "•",
};

/** Status is always icon + label, never colour alone. */
export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-raised px-2 py-0.5 text-xs font-medium text-ink">
      <span
        aria-hidden
        className={cx(
          "grid size-3.5 place-items-center rounded-full text-[9px] leading-none font-bold text-white",
          TONE_DOT[tone],
        )}
      >
        {TONE_ICON[tone]}
      </span>
      {children}
    </span>
  );
}

const JOB_STATUS: Record<JobStatus, [Tone, string]> = {
  printing: ["accent", "Printing"],
  finished: ["good", "Finished"],
  failed: ["critical", "Failed"],
  cancelled: ["neutral", "Cancelled"],
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const [tone, label] = JOB_STATUS[status];
  return <Badge tone={tone}>{label}</Badge>;
}

const PRINTER_STATE: Record<GcodeState, [Tone, string]> = {
  IDLE: ["neutral", "Idle"],
  INIT: ["neutral", "Starting"],
  SLICING: ["accent", "Slicing"],
  PREPARE: ["accent", "Preparing"],
  RUNNING: ["accent", "Printing"],
  PAUSE: ["warning", "Paused"],
  FINISH: ["good", "Finished – clear bed"],
  FAILED: ["critical", "Failed"],
  UNKNOWN: ["neutral", "Unknown"],
};

export function PrinterStateBadge({ state, online }: { state: GcodeState; online: boolean }) {
  if (!online) return <Badge tone="neutral">Offline</Badge>;
  const [tone, label] = PRINTER_STATE[state];
  return <Badge tone={tone}>{label}</Badge>;
}

/** A filament colour swatch; the colour is the data, so it is shown as-is with a hairline ring. */
export function Swatch({ color, size = 12, title }: { color: string | null; size?: number; title?: string }) {
  const c = hex(color);
  return (
    <span
      title={title}
      className="inline-block shrink-0 rounded-full ring-1 ring-hairline"
      style={{
        width: size,
        height: size,
        background:
          c ?? "repeating-linear-gradient(45deg, var(--color-wash) 0 2px, var(--color-line) 2px 4px)",
      }}
    />
  );
}

export function FilamentChips({ filaments }: { filaments: FilamentChip[] }) {
  if (filaments.length === 0) return <span className="text-muted">–</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {filaments.map((f) => (
        <span key={f.idx} className="inline-flex items-center gap-1 text-xs text-ink-2">
          <Swatch color={f.color} size={10} />
          {f.material ?? "?"}
          {f.weightG !== null && <span className="tabular text-muted">{grams(f.weightG)}</span>}
        </span>
      ))}
    </span>
  );
}

export function StatTile({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <Card className="p-4">
      <div className="text-xs font-medium tracking-wide text-ink-2 uppercase">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {note && <div className="mt-0.5 text-xs text-muted">{note}</div>}
    </Card>
  );
}

export function ProgressBar({
  value,
  tone = "accent",
}: {
  value: number;
  tone?: "accent" | "warning" | "critical";
}) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-wash"
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={cx(
          "h-full rounded-full",
          tone === "accent" ? "bg-accent" : tone === "warning" ? "bg-warning" : "bg-critical",
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function Thumb({ src, alt, size = 48 }: { src: string | null; alt: string; size?: number }) {
  return src ? (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      className="shrink-0 rounded-md border border-hairline bg-wash object-contain"
      style={{ width: size, height: size }}
    />
  ) : (
    <div
      aria-hidden
      className="grid shrink-0 place-items-center rounded-md border border-hairline bg-wash text-muted"
      style={{ width: size, height: size, fontSize: size / 3 }}
    >
      ▢
    </div>
  );
}

export function Button({
  variant = "secondary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost" }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary" && "bg-accent text-white hover:brightness-110",
        variant === "secondary" && "border border-hairline bg-raised text-ink hover:bg-wash",
        variant === "danger" && "border border-hairline bg-raised text-critical hover:bg-wash",
        variant === "ghost" && "text-ink-2 hover:bg-wash hover:text-ink",
        className,
      )}
    />
  );
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cx(
        "rounded-lg border border-hairline bg-raised px-2.5 py-1.5 text-sm text-ink focus:outline-2 focus:outline-accent",
        props.className,
      )}
    />
  );
}

export const inputClass =
  "rounded-lg border border-hairline bg-raised px-2.5 py-1.5 text-sm text-ink placeholder:text-muted focus:outline-2 focus:outline-accent";

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <div className="py-16 text-center text-sm text-muted">{label}</div>;
}

export function ErrorState({ error }: { error: unknown }) {
  const status = error instanceof ApiError ? error.status : 0;
  const message =
    status === 401
      ? "You're not signed in. Reload the page to sign in through Cloudflare Access."
      : error instanceof Error
        ? error.message
        : "Something went wrong.";
  return (
    <Card className="p-6">
      <div className="flex items-start gap-3">
        <Badge tone="critical">Error</Badge>
        <p className="text-sm text-ink-2">{message}</p>
      </div>
    </Card>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <Card className="px-6 py-12 text-center">
      <div className="font-medium">{title}</div>
      {children && <div className="mx-auto mt-2 max-w-md text-sm text-ink-2">{children}</div>}
    </Card>
  );
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <th
      className={cx("px-3 py-2 text-left text-xs font-medium tracking-wide text-ink-2 uppercase", className)}
    >
      {children}
    </th>
  );
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cx("px-3 py-2.5 align-middle", className)}>{children}</td>;
}
