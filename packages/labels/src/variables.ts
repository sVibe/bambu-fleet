import type { LabelValues } from "./template.ts";

/** A placeholder a part label can use, with an example value for previews and test prints. */
export interface LabelVariable {
  name: string;
  description: string;
  example: string;
}

export const PART_VARIABLES: LabelVariable[] = [
  { name: "part.number", description: "Part number, or the part name when none is set", example: "2600067" },
  { name: "part.name", description: "Part name", example: "Bracket v3" },
  { name: "part.notes", description: "Notes on the part", example: "Use PETG" },
  { name: "part.material", description: "Most used material", example: "PETG" },
  { name: "part.materials", description: "All materials it was printed in", example: "PETG, PLA" },
  { name: "part.avg_g", description: "Average grams per piece", example: "12.4" },
  { name: "part.total_g", description: "Grams used for all printed pieces", example: "3720" },
  { name: "part.printed", description: "Pieces printed in finished jobs", example: "300" },
  { name: "part.failed", description: "Pieces in failed or cancelled jobs", example: "6" },
  { name: "part.jobs", description: "Jobs that included the part", example: "12" },
  { name: "part.last_printed", description: "Date of the last finished print", example: "17.11.2026" },
  {
    name: "part.url",
    description: "Link to the part in the dashboard",
    example: "https://fleet.example/parts/1",
  },
  { name: "label.qty", description: "Quantity entered when printing, e.g. “50 pcs”", example: "50 pcs" },
  { name: "label.date", description: "Date of printing", example: "17.11.2026" },
  { name: "label.time", description: "Time of printing", example: "14:02" },
];

export const EXAMPLE_PART_VALUES: LabelValues = Object.fromEntries(
  PART_VARIABLES.map((v) => [v.name, v.example]),
);
