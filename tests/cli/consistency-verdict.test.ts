import { describe, test, expect } from "bun:test";
import { resolveConsistencyVerdict, type CanarySignals } from "../../bin/check-consistency-gate.js";

// #384 rev4: unit-test the pure verdict resolver. Covers all P1/P2 states
// that are expensive or non-deterministic to trigger end-to-end:
//   - fatal → exit 2 (not 1)
//   - canary with unexpected hard finding → NO-GO, not passed
//   - canary missing expected check → regression NO-GO
//   - healthy fixture failure → explicit failure status
//   - clean path → GO, exit 0

function base(overrides: Partial<CanarySignals> = {}): CanarySignals {
	return {
		healthyPassed: true,
		healthyFatal: false,
		canaryPassed: false,
		canaryFatal: false,
		expectedPresent: true,
		unexpectedHardChecks: [],
		...overrides,
	};
}

describe("resolveConsistencyVerdict (#384 rev4)", () => {
	test("clean healthy + detected canary → GO, exit 0", () => {
		const v = resolveConsistencyVerdict(base());
		expect(v.status).toBe("negative_canary_detected");
		expect(v.passed).toBe(true);
		expect(v.exitCode).toBe(0);
	});

	test("(P1) canary with unexpected hard finding → NO-GO, exit 1", () => {
		const v = resolveConsistencyVerdict(base({
			unexpectedHardChecks: ["fts.coverage_gap"],
		}));
		expect(v.status).toBe("negative_canary_unexpected_hard");
		expect(v.passed).toBe(false);
		expect(v.exitCode).toBe(1);
	});

	test("(P1) canary missing expected check → regression, NO-GO", () => {
		const v = resolveConsistencyVerdict(base({ expectedPresent: false }));
		expect(v.status).toBe("negative_canary_regression");
		expect(v.passed).toBe(false);
		expect(v.exitCode).toBe(1);
	});

	test("(rev5 P2-1) canary unexpectedly passed → negative_canary_regression, not detected status", () => {
		const v = resolveConsistencyVerdict(base({ canaryPassed: true }));
		expect(v.status).toBe("negative_canary_regression");
		expect(v.passed).toBe(false);
		expect(v.exitCode).toBe(1);
		expect(v.canaryDetected).toBe(false);
	});

	test("(P2) healthy fatal → fixture_setup_failed, exit 2 (not 1)", () => {
		const v = resolveConsistencyVerdict(base({ healthyFatal: true }));
		expect(v.status).toBe("fixture_setup_failed");
		expect(v.passed).toBe(false);
		expect(v.exitCode).toBe(2);
	});

	test("(P2) canary fatal → exit 2 (not 1)", () => {
		const v = resolveConsistencyVerdict(base({ canaryFatal: true }));
		expect(v.status).toBe("fixture_setup_failed");
		expect(v.passed).toBe(false);
		expect(v.exitCode).toBe(2);
	});

	test("healthy fixture failed but canary clean → healthy_fixture_failed, exit 1", () => {
		const v = resolveConsistencyVerdict(base({ healthyPassed: false }));
		expect(v.status).toBe("healthy_fixture_failed");
		expect(v.passed).toBe(false);
		expect(v.exitCode).toBe(1);
	});

	test("fatal takes priority over unexpected hard", () => {
		const v = resolveConsistencyVerdict(base({
			healthyFatal: true,
			unexpectedHardChecks: ["something.bad"],
		}));
		expect(v.status).toBe("fixture_setup_failed");
		expect(v.exitCode).toBe(2);
	});

	test("(rev5 P2-2) canaryDetected is independent of gate passed", () => {
		// Healthy fixture fails but canary correctly detected → canaryDetected
		// is true even though the overall gate does not pass.
		const v = resolveConsistencyVerdict(base({ healthyPassed: false }));
		expect(v.canaryDetected).toBe(true);
		expect(v.passed).toBe(false);
		expect(v.status).toBe("healthy_fixture_failed");
	});
});
