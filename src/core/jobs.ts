import { CBrainDB } from "../storage/sqlite.js";

export type JobHandler = (data: unknown, jobId: number) => Promise<unknown>;

export class JobQueue {
  private db: CBrainDB;
  private handlers: Map<string, JobHandler> = new Map();
  private running = false;

  constructor(db: CBrainDB) {
    this.db = db;
  }

  register(name: string, handler: JobHandler): void {
    this.handlers.set(name, handler);
  }

  submit(name: string, data?: unknown, priority?: number): number {
    return this.db.submitJob(name, data, priority);
  }

  list(status?: string) {
    return this.db.listJobs(status);
  }

  get(id: number) {
    return this.db.getJob(id);
  }

  cancel(id: number): boolean {
    return this.db.cancelJob(id);
  }

  retry(id: number): boolean {
    return this.db.retryJob(id);
  }

  async work(tickMs = 1000): Promise<void> {
    this.running = true;
    while (this.running) {
      const handlerNames = [...this.handlers.keys()];
      // Scoped: only claim jobs with registered handlers. Falls back to claimJob when no handlers registered (backward compat).
      const job = handlerNames.length > 0
        ? this.db.claimJobForNames(handlerNames)
        : this.db.claimJob();
      if (!job) {
        await new Promise((r) => setTimeout(r, tickMs));
        continue;
      }

      const handler = this.handlers.get(job.name);
      if (!handler) {
        this.db.failJob(job.id, `No handler for job: ${job.name}`);
        continue;
      }

      try {
        const data = job.data ? JSON.parse(job.data) : undefined;
        const result = await handler(data, job.id);
        this.db.completeJob(job.id, result);
      } catch (err) {
        this.db.failJob(job.id, err instanceof Error ? err.message : String(err));
      }
    }
  }

  /** Start background work loop. Returns immediately; runs until stop(). */
  start(): void {
    if (this.running) return;
    this.work(2000).catch(e => console.error("[JobQueue] work loop crashed:", e));
  }

  stop(): void {
    this.running = false;
  }
}
