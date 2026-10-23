import { pgSchema, serial, text } from "drizzle-orm/pg-core";

export const alpha = pgSchema("test_alpha");

export const widgets = alpha.table("widgets", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  note: text("note"),
});
