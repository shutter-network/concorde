import { pushSchema } from "drizzle-kit/api";
import type { Db } from "../db/index.ts";

export type PartSchema = Record<string, unknown>;

export async function applySchema(db: Db, ...parts: readonly PartSchema[]): Promise<void> {
  const { apply } = await pushSchema(exportsOf(parts), db.handle({}));
  await apply();
}

function exportsOf(parts: readonly PartSchema[]): Record<string, unknown> {
  const all: Record<string, unknown> = {};
  for (const [index, part] of parts.entries()) {
    for (const [name, value] of Object.entries(part)) all[`${index}:${name}`] = value;
  }
  return all;
}
