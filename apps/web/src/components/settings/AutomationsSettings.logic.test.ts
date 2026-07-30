import { describe, expect, it } from "vite-plus/test";

import {
  parseAutomationScheduleFields,
  parseAutomationTextFields,
} from "./AutomationsSettings.logic";

describe("Automation settings form", () => {
  it("normalizes valid schedule fields", () => {
    expect(parseAutomationScheduleFields(" 0 9 * * 1-5 ", " Europe/London ")).toEqual({
      ok: true,
      value: { cronExpression: "0 9 * * 1-5", timeZone: "Europe/London" },
    });
  });

  it.each([
    ["", "Europe/London", "Enter a cron schedule."],
    ["0 9 * * *", "", "Enter a time zone."],
    ["x".repeat(161), "UTC", "Cron schedule must be 160 characters or less."],
    ["0 9 * * *", "x".repeat(129), "Time zone must be 128 characters or less."],
  ])("rejects invalid schedule fields without throwing", (cron, timeZone, error) => {
    expect(parseAutomationScheduleFields(cron, timeZone)).toEqual({ ok: false, error });
  });

  it("normalizes name and instructions", () => {
    expect(parseAutomationTextFields(" Morning report ", " Scan the feed ")).toEqual({
      ok: true,
      value: { name: "Morning report", prompt: "Scan the feed" },
    });
  });

  it.each([
    ["", "prompt", "Enter a name."],
    ["name", "", "Enter instructions."],
    ["x".repeat(161), "prompt", "Name must be 160 characters or less."],
    ["name", "x".repeat(120_001), "Instructions must be 120,000 characters or less."],
  ])("rejects invalid text fields without throwing", (name, prompt, error) => {
    expect(parseAutomationTextFields(name, prompt)).toEqual({ ok: false, error });
  });
});
