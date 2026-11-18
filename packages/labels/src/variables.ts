import type { LabelSource, LabelValues } from "./template.ts";

/** A placeholder a label can use, with an example value for previews and test prints. */
export interface LabelVariable {
  name: string;
  description: string;
  example: string;
}

export interface LabelVariableGroup {
  label: string;
  variables: LabelVariable[];
}

const LABEL_GROUP: LabelVariableGroup = {
  label: "Label",
  variables: [
    { name: "label.qty", description: "Quantity entered when printing, e.g. “50 pcs”", example: "50 pcs" },
    { name: "label.date", description: "Date of printing", example: "17.11.2026" },
    { name: "label.time", description: "Time of printing", example: "14:02" },
  ],
};

const PART_GROUP: LabelVariableGroup = {
  label: "Part",
  variables: [
    {
      name: "part.number",
      description: "Part number, or the part name when none is set",
      example: "2600067",
    },
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
  ],
};

const JOB_PART_GROUP: LabelVariableGroup = {
  label: "Part in this job",
  variables: [
    {
      name: "part.number",
      description: "Number of the part the job printed most of; the job name without part data",
      example: "2600067",
    },
    { name: "part.name", description: "Name of that part", example: "Bracket v3" },
    { name: "part.qty", description: "Pieces of that part in this job", example: "24" },
    { name: "part.g", description: "Grams per piece of that part in this job", example: "12.4" },
  ],
};

const JOB_GROUP: LabelVariableGroup = {
  label: "Job",
  variables: [
    { name: "job.name", description: "Job name", example: "2600067_24_5_260626" },
    { name: "job.printer", description: "Printer that printed it", example: "X1C-1" },
    { name: "job.status", description: "Finished, failed, cancelled or printing", example: "finished" },
    { name: "job.started", description: "Start date and time", example: "17.11.2026 08:12" },
    { name: "job.ended", description: "End date", example: "17.11.2026" },
    { name: "job.duration", description: "How long it printed", example: "5 h 40 min" },
    { name: "job.plate", description: "Plate number in the file", example: "1" },
    { name: "job.file", description: "File name", example: "2600067_24_5_260626.3mf" },
    { name: "job.material", description: "Materials used", example: "PETG" },
    { name: "job.grams", description: "Filament used, in grams", example: "298" },
    { name: "job.waste_g", description: "Purge and prime tower, in grams", example: "14" },
    { name: "job.pieces", description: "Pieces printed, all parts", example: "24" },
    { name: "job.parts", description: "Parts and pieces, e.g. “2600067 ×24”", example: "2600067 ×24" },
    {
      name: "job.url",
      description: "Link to the job in the dashboard",
      example: "https://fleet.example/jobs/1",
    },
  ],
};

/** The variables each kind of template can use, grouped for the editor's picker. */
export const LABEL_VARIABLES: Record<LabelSource, LabelVariableGroup[]> = {
  part: [PART_GROUP, LABEL_GROUP],
  job: [JOB_PART_GROUP, JOB_GROUP, LABEL_GROUP],
};

/** Example values for a kind of template, for previews and test prints. */
export function exampleValues(source: LabelSource): LabelValues {
  return Object.fromEntries(
    LABEL_VARIABLES[source].flatMap((g) => g.variables.map((v) => [v.name, v.example])),
  );
}

export const EXAMPLE_PART_VALUES: LabelValues = exampleValues("part");
