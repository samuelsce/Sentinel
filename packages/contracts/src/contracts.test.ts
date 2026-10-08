import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  eventBatchSchema,
  isEventWithinTimeWindow,
  securityEventSchema,
} from "./index.js";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/events.v1.json", import.meta.url), "utf8"),
) as {
  base: Record<string, unknown>;
  cases: {
    name: string;
    valid: boolean;
    set: Record<string, unknown>;
    remove?: string[];
  }[];
};
const ajv = new Ajv2020.default({ strict: true, allErrors: true });
addFormats.default(ajv);
const validateEvent = ajv.compile(
  JSON.parse(
    readFileSync(
      new URL("../schema/security-event.v1.json", import.meta.url),
      "utf8",
    ),
  ),
);
const validateBatch = ajv.compile(
  JSON.parse(
    readFileSync(
      new URL("../schema/event-batch.v1.json", import.meta.url),
      "utf8",
    ),
  ),
);

describe("event v1: Zod and JSON Schema agree", () => {
  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      const event = { ...fixture.base, ...testCase.set };
      for (const key of testCase.remove ?? []) delete event[key];
      expect(securityEventSchema.safeParse(event).success).toBe(testCase.valid);
      expect(validateEvent(event), JSON.stringify(validateEvent.errors)).toBe(
        testCase.valid,
      );
    });
  }
  it.each([0, 1, 100, 101])("agrees on batch size %i", (size) => {
    const batch = { events: Array.from({ length: size }, () => fixture.base) };
    const expected = size > 0 && size <= 100;
    expect(eventBatchSchema.safeParse(batch).success).toBe(expected);
    expect(validateBatch(batch)).toBe(expected);
  });
  it("rejects unknown batch fields", () => {
    const batch = { events: [fixture.base], token: "not-allowed" };
    expect(eventBatchSchema.safeParse(batch).success).toBe(false);
    expect(validateBatch(batch)).toBe(false);
  });
  it("evaluates clock boundaries independently of wall time", () => {
    const event = securityEventSchema.parse(fixture.base);
    const occurred = Date.parse(event.occurred_at);
    expect(
      isEventWithinTimeWindow(event, new Date(occurred + 24 * 60 * 60_000)),
    ).toBe(true);
    expect(
      isEventWithinTimeWindow(event, new Date(occurred + 24 * 60 * 60_000 + 1)),
    ).toBe(false);
    expect(isEventWithinTimeWindow(event, new Date(occurred - 120_000))).toBe(
      true,
    );
    expect(isEventWithinTimeWindow(event, new Date(occurred - 120_001))).toBe(
      false,
    );
  });
});
