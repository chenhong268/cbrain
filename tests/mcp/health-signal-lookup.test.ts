import { describe, expect, test } from "bun:test";
import type { ToolContext } from "../../src/mcp/context.js";
import { createHealthSignalLookup } from "../../src/mcp/tools/ops.js";

describe("createHealthSignalLookup", () => {
  test("caches per slug and returns page signals from read-only DB methods", () => {
    let tierReads = 0;
    let incomingReads = 0;
    const ctx = {
      db: {
        getPageTierAndMentions(slug: string) {
          tierReads++;
          expect(slug).toBe("entity/entity-a");
          return { tier: 3, mention_count: 4, activity_weight: 0 };
        },
        getIncomingLinks(slug: string) {
          incomingReads++;
          expect(slug).toBe("entity/entity-a");
          return [{ id: 1 }, { id: 2 }];
        },
      },
    } as unknown as ToolContext;

    const lookup = createHealthSignalLookup(ctx);

    expect(lookup("entity/entity-a")).toEqual({ mentionCount: 4, incomingLinkCount: 2 });
    expect(lookup("entity/entity-a")).toEqual({ mentionCount: 4, incomingLinkCount: 2 });
    expect(tierReads).toBe(1);
    expect(incomingReads).toBe(1);
  });

  test("bounds lookups to avoid amplifying large health reports", () => {
    let tierReads = 0;
    let incomingReads = 0;
    const ctx = {
      db: {
        getPageTierAndMentions() {
          tierReads++;
          return { tier: 3, mention_count: 1, activity_weight: 0 };
        },
        getIncomingLinks() {
          incomingReads++;
          return [];
        },
      },
    } as unknown as ToolContext;

    const lookup = createHealthSignalLookup(ctx);

    for (let i = 0; i < 250; i++) {
      lookup(`entity/entity-${i}`);
    }

    expect(tierReads).toBe(200);
    expect(incomingReads).toBe(200);
    expect(lookup("entity/entity-after-cap")).toBeUndefined();
    expect(tierReads).toBe(200);
    expect(incomingReads).toBe(200);
  });
});
