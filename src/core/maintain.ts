import type { SyncManager, SyncReport } from "./sync.js";
import type { EnrichManager, EnrichResult } from "./enrich.js";
import type { HealthChecker, HealthReport } from "./health.js";

export interface MaintainReport {
  timestamp: string;
  sync: SyncReport;
  enrich: { total: number; upgraded: number };
  health: HealthReport;
}

export async function runMaintenance(
  vaultPath: string,
  syncMgr: SyncManager,
  enrichMgr: EnrichManager,
  healthChecker: HealthChecker,
): Promise<MaintainReport> {
  const syncReport = await syncMgr.syncAll(vaultPath);

  const enrichResults: EnrichResult[] = enrichMgr.enrichAll();
  const upgraded = enrichResults.filter((r) => r.upgraded).length;

  const healthReport = await healthChecker.checkAll();

  return {
    timestamp: new Date().toISOString(),
    sync: syncReport,
    enrich: { total: enrichResults.length, upgraded },
    health: healthReport,
  };
}
