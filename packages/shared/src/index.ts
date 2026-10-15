export * from "./consumption.ts";
export * from "./filaments.ts";
export * from "./ingest.ts";
export * from "./md5.ts";
export * from "./parts.ts";
export * from "./printer.ts";
export * from "./queue.ts";

export const ROLES = ["viewer", "operator", "admin"] as const;
export type Role = (typeof ROLES)[number];

export function roleAtLeast(role: Role, required: Role): boolean {
  return ROLES.indexOf(role) >= ROLES.indexOf(required);
}
