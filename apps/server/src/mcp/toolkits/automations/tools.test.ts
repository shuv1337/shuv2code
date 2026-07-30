import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

import { AutomationCreateTool, AutomationToolkit } from "./tools.ts";

const schemaHasDescription = (schema: unknown): boolean => {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  if (typeof record.description === "string" && record.description.length > 0) return true;
  return [record.anyOf, record.oneOf, record.allOf]
    .filter(Array.isArray)
    .some((members) => members.some(schemaHasDescription));
};

it("exports the complete project-scoped automation tool surface", () => {
  expect(Object.keys(AutomationToolkit.tools).sort()).toEqual([
    "automation_create",
    "automation_delete",
    "automation_get",
    "automation_list",
    "automation_list_runs",
    "automation_run_now",
    "automation_update",
    "automation_validate_schedule",
  ]);
});

it("exports provider-compatible object schemas with described parameters", () => {
  for (const tool of Object.values(AutomationToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    expect(tool.description?.length ?? 0).toBeGreaterThan(40);
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined();
    for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
      expect(
        schemaHasDescription(fieldSchema),
        `${tool.name}.${field} should explain what data the agent must pass`,
      ).toBe(true);
    }
  }
});

it("marks durable creation as destructive", () => {
  expect(Context.get(AutomationCreateTool.annotations, Tool.Destructive)).toBe(true);
});
