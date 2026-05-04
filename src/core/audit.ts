export interface MetricsSnapshot {
  timestamp: string;
  totalPages: number;
  entities: number;
  concepts: number;
  events: number;
  records: number;
  totalLinks: number;
  avgMentionsPerPage: number;
  orphans: number;
  bareStubs: number;
  conceptsPerSource: number;
  indexSizeKB: number;
}
