import { z } from "zod";

export const FsckSeveritySchema = z.enum(["critical", "error", "warning", "info"]);
export type FsckSeverity = z.infer<typeof FsckSeveritySchema>;

export const FsckLayerSchema = z.enum(["vault", "sqlite", "fts", "lance"]);
export type FsckLayer = z.infer<typeof FsckLayerSchema>;

export const FsckOverallStatusSchema = z.enum(["pass", "warn", "fail"]);
export type FsckOverallStatus = z.infer<typeof FsckOverallStatusSchema>;

export const FsckLanceStateSchema = z.enum(["ok", "missing", "corrupt", "unchecked"]);
export type FsckLanceState = z.infer<typeof FsckLanceStateSchema>;

export const FsckFindingSchema = z.object({
	check: z.string(),
	layer: FsckLayerSchema,
	severity: FsckSeveritySchema,
	count: z.number().int().nonnegative(),
	sampleSlugs: z.array(z.string()).max(5),
	detail: z.string(),
	suggestedCommand: z.string(),
});
export type FsckFinding = z.infer<typeof FsckFindingSchema>;

export const FsckReportSchema = z.object({
	version: z.literal(1),
	timestamp: z.string(),
	overallStatus: FsckOverallStatusSchema,
	counts: z.object({
		critical: z.number(),
		error: z.number(),
		warning: z.number(),
		info: z.number(),
	}),
	lanceState: FsckLanceStateSchema,
	fatalError: z.string().optional(),
	findings: z.array(FsckFindingSchema),
});
export type FsckReport = z.infer<typeof FsckReportSchema>;
