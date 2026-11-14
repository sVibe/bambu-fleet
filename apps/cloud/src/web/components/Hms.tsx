import { formatPrintError, type HmsEntry } from "@fleet/shared";
import type { ErrorTextTable } from "../../api-types.ts";
import { useErrorText } from "../api.ts";
import { Badge, cx } from "./ui.tsx";

/** HMS codes as Bambu writes them: 0300_0100_0001_0007. */
export const formatHms = (code: string) => code.replace(/(.{4})(?!$)/g, "$1_");

/** print_error as the 8-hex-digit key Bambu's tables use. */
export const printErrorKey = (code: number) => (code >>> 0).toString(16).toUpperCase().padStart(8, "0");

/** A printer's model family: the first three characters of its serial. */
const prefixOf = (serial: string) => serial.slice(0, 3).toUpperCase();

function lookup(texts: Record<string, string> | undefined, serial: string): string | null {
  if (!texts) return null;
  return texts[prefixOf(serial)] ?? texts[""] ?? null;
}

export function describeHms(table: ErrorTextTable | undefined, code: string, serial: string): string | null {
  return lookup(table?.hms[code.toUpperCase()], serial);
}

export function describePrintError(
  table: ErrorTextTable | undefined,
  code: number,
  serial: string,
): string | null {
  return lookup(table?.error[printErrorKey(code)], serial);
}

/** Bambu redirects this to the model's wiki article for the code. */
const hmsWikiUrl = (code: string, serial: string) =>
  `https://e.bambulab.com/index.php?e=${code.toUpperCase()}&d=${prefixOf(serial)}&s=device_hms&lang=en`;

const PRINT_ERROR_WIKI = "https://wiki.bambulab.com/en/hms/error-code";

/** HMS severity is the code's high 16 bits; Bambu's levels are 1 fatal to 4 info. */
const SEVERITY: Record<number, { label: string; tone: "critical" | "serious" | "warning" | "neutral" }> = {
  1: { label: "Fatal", tone: "critical" },
  2: { label: "Serious", tone: "serious" },
  3: { label: "Common", tone: "warning" },
  4: { label: "Info", tone: "neutral" },
};

/** A printer's active HMS alerts, each with Bambu's description and a link to its wiki article. */
export function HmsAlerts({
  hms,
  serial,
  className,
}: {
  hms: HmsEntry[];
  serial: string;
  className?: string;
}) {
  const table = useErrorText().data;
  return (
    <ul className={cx("space-y-2 border-t border-hairline pt-3 text-xs", className)}>
      {hms.map((h) => {
        const severity = SEVERITY[h.severity ?? 0] ?? { label: "HMS", tone: "warning" as const };
        return (
          <li key={h.code} className="flex items-start gap-2">
            <span className="shrink-0">
              <Badge tone={severity.tone}>{severity.label}</Badge>
            </span>
            <span className="min-w-0 text-ink-2">
              <span className="text-ink">{describeHms(table, h.code, serial) ?? "Unknown HMS code"}</span>{" "}
              <a
                href={hmsWikiUrl(h.code, serial)}
                target="_blank"
                rel="noreferrer"
                className="font-mono whitespace-nowrap text-muted hover:text-ink hover:underline"
              >
                {formatHms(h.code)} ↗
              </a>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Alert count for compact rows; the descriptions are in the tooltip. */
export function HmsCount({ hms, serial }: { hms: HmsEntry[]; serial: string }) {
  const table = useErrorText().data;
  return (
    <span
      title={hms
        .map((h) => `${formatHms(h.code)}: ${describeHms(table, h.code, serial) ?? "Unknown HMS code"}`)
        .join("\n")}
    >
      <Badge tone="warning">{hms.length} HMS</Badge>
    </span>
  );
}

/** A print_error as Bambu's description plus the code; just the code when there is no description. */
export function PrintError({ code, serial }: { code: number; serial: string }) {
  const text = describePrintError(useErrorText().data, code, serial);
  return (
    <>
      {text && `${text} `}
      <a
        href={PRINT_ERROR_WIKI}
        target="_blank"
        rel="noreferrer"
        className="font-mono whitespace-nowrap text-muted hover:text-ink hover:underline"
      >
        {formatPrintError(code)} ↗
      </a>
    </>
  );
}
