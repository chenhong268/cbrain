import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "../../src/profile/manager.js";
import {
  buildAgentVisibleStats,
  type ProfileUpdateInput,
  validateAgentProfileUpdate,
} from "../../src/mcp/tools/profile-policy.js";

const VALID_UPDATE: ProfileUpdateInput = {
  id: "response-length-short",
  type: "preference",
  category: "communication",
  scope: "open",
  content: "回复保持简洁",
  source: "explicit",
};

const PROFILE_YAML = `version: 1
user:
  id: test-user
entries:
  - id: scoped-existing
    type: context
    category: work
    scope: scoped
    agents:
      - trusted-agent
    content: scoped detail
    source: explicit
    updated_at: 2026-07-15
  - id: private-existing
    type: constraint
    category: general
    scope: private
    content: private detail
    source: explicit
    updated_at: 2026-07-15
`;

describe("daily Agent Profile policy", () => {
  let root: string;
  let profilePath: string;
  let profile: ProfileManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cbrain-profile-policy-"));
    profilePath = join(root, "profile.yaml");
    writeFileSync(profilePath, PROFILE_YAML, "utf-8");
    profile = new ProfileManager(root);
    profile.load();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("accepts one explicit open update", () => {
    expect(validateAgentProfileUpdate(profile, [VALID_UPDATE])).toBeNull();
  });

  test("rejects an absent or empty update batch", () => {
    expect(validateAgentProfileUpdate(profile, undefined)).toBe("PROFILE_UPDATE_INVALID");
    expect(validateAgentProfileUpdate(profile, [])).toBe("PROFILE_UPDATE_INVALID");
  });

  test("rejects non-explicit sources and non-open scopes", () => {
    expect(validateAgentProfileUpdate(profile, [{ ...VALID_UPDATE, source: "observed" }]))
      .toBe("PROFILE_UPDATE_INVALID");
    expect(validateAgentProfileUpdate(profile, [{ ...VALID_UPDATE, source: "inferred" }]))
      .toBe("PROFILE_UPDATE_INVALID");
    expect(validateAgentProfileUpdate(profile, [{ ...VALID_UPDATE, source: undefined }]))
      .toBe("PROFILE_UPDATE_INVALID");
    expect(validateAgentProfileUpdate(profile, [{ ...VALID_UPDATE, scope: "scoped" }]))
      .toBe("PROFILE_UPDATE_INVALID");
    expect(validateAgentProfileUpdate(profile, [{ ...VALID_UPDATE, scope: "private" }]))
      .toBe("PROFILE_UPDATE_INVALID");
  });

  test("rejects duplicate IDs within the same batch", () => {
    expect(validateAgentProfileUpdate(profile, [VALID_UPDATE, { ...VALID_UPDATE }]))
      .toBe("PROFILE_UPDATE_INVALID");
  });

  test("rejects direct collisions with hidden existing IDs using only the generic code", () => {
    for (const id of ["scoped-existing", "private-existing"]) {
      expect(validateAgentProfileUpdate(profile, [{ ...VALID_UPDATE, id }]))
        .toBe("PROFILE_UPDATE_INVALID");
    }
  });

  test("preflights the whole batch and has no write or in-memory side effects", () => {
    const bytesBefore = readFileSync(profilePath);
    const entriesBefore = profile.getEntries();
    const hiddenCollision = { ...VALID_UPDATE, id: "private-existing" };

    expect(validateAgentProfileUpdate(profile, [VALID_UPDATE])).toBeNull();
    expect(validateAgentProfileUpdate(profile, [VALID_UPDATE, hiddenCollision]))
      .toBe("PROFILE_UPDATE_INVALID");

    expect(readFileSync(profilePath).equals(bytesBefore)).toBe(true);
    expect(profile.getEntries()).toEqual(entriesBefore);
    expect(profile.getEntry(VALID_UPDATE.id)).toBeUndefined();
  });

  test("rejects empty or whitespace-only IDs and content", () => {
    expect(validateAgentProfileUpdate(profile, [{ ...VALID_UPDATE, id: "" }]))
      .toBe("PROFILE_UPDATE_INVALID");
    expect(validateAgentProfileUpdate(profile, [{ ...VALID_UPDATE, id: " \t\n " }]))
      .toBe("PROFILE_UPDATE_INVALID");
    expect(validateAgentProfileUpdate(profile, [{ ...VALID_UPDATE, content: "" }]))
      .toBe("PROFILE_UPDATE_INVALID");
    expect(validateAgentProfileUpdate(profile, [{ ...VALID_UPDATE, content: " \t\n " }]))
      .toBe("PROFILE_UPDATE_INVALID");
  });

  test("rejects invalid runtime enum values", () => {
    const invalidType = {
      ...VALID_UPDATE,
      type: "opinion",
    } as unknown as ProfileUpdateInput;

    expect(validateAgentProfileUpdate(profile, [invalidType])).toBe("PROFILE_UPDATE_INVALID");
  });

  test("rejects updates restricted to named agents", () => {
    expect(validateAgentProfileUpdate(profile, [{ ...VALID_UPDATE, agents: ["agent-a"] }]))
      .toBe("PROFILE_UPDATE_INVALID");
  });

  test("builds stats only from the supplied Agent-visible entries", () => {
    const entries = profile.getEntries();

    expect(buildAgentVisibleStats(entries)).toEqual({
      total: 2,
      byScope: { scoped: 1, private: 1 },
      byType: { context: 1, constraint: 1 },
      modules: 0,
    });
  });
});
