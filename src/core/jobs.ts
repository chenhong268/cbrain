import { CBrainDB } from "../storage/sqlite.js";
import type { Logger } from "./logger.js";

export interface JobExecution {
  signal: AbortSignal;
  checkCancelled(): void;
}

export type JobHandler = (data: unknown, jobId: number, execution: JobExecution) => Promise<unknown>;

export class JobQueue {
  private db: CBrainDB;
  private logger?: Logger;
  private handlers: Map<string, JobHandler> = new Map();
  private running = false;
  private active?: { id: number; controller: AbortController };

  constructor(db: CBrainDB, logger?: Logger) {
    this.db = db;
    this.logger = logger;
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
    const cancelled = this.db.cancelJob(id);
    if (cancelled && this.active?.id === id) this.active.controller.abort();
    return cancelled;
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

      const controller = new AbortController();
      this.active = { id: job.id, controller };
      const checkCancelled = () => {
        if (this.db.getJob(job.id)?.status !== "running") controller.abort();
        controller.signal.throwIfAborted();
      };
      try {
        checkCancelled();
        const data = job.data ? JSON.parse(job.data) : undefined;
        const result = await handler(data, job.id, { signal: controller.signal, checkCancelled });
        checkCancelled();
        this.db.completeJob(job.id, result);
      } catch (err) {
        if (!controller.signal.aborted && this.db.getJob(job.id)?.status === "running") {
          this.db.failJob(job.id, err instanceof Error ? err.message : String(err));
        }
      } finally {
        this.active = undefined;
      }
    }
  }

  /** Start background work loop. Returns immediately; runs until stop(). */
  start(): void {
    if (this.running) return;
    this.work(2000).catch(e => this.logger?.error("jobs", "work loop crashed", { error: e instanceof Error ? e.stack ?? e.message : String(e) }));
  }

  stop(): void {
    this.running = false;
  }
}
