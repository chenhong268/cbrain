import { RecommendationStore } from "./record-store.js";
import type { RecommendationRecord } from "./types.js";

/** Nominal, read-only facade over the store's trusted row decoder. */
export class RecommendationRecordReader {
  readonly #store: RecommendationStore;

  private constructor(store: RecommendationStore) {
    this.#store = store;
  }

  static fromStore(store: RecommendationStore): RecommendationRecordReader {
    return new RecommendationRecordReader(store);
  }

  getById(id: string): RecommendationRecord | null {
    return this.#store.getById(id);
  }
}
