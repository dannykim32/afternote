import type {
  DerivedIndexStatus,
  EmbeddingModelDescriptor,
} from "./retrieval";

export type DerivedIndexAdapter<Note> = {
  model: EmbeddingModelDescriptor | null;
  rebuildSynchronous(): void;
  replaceSynchronous(note: Note): void;
  missingSemanticNotes(): readonly Note[];
  indexSemanticNotes(
    notes: readonly Note[],
    reportError: (error: unknown) => void,
  ): Promise<void>;
  totalNotes(): number;
  indexedNotes(): number;
  invalidateSemanticCache?(): void;
};

/**
 * Owns the lifecycle of data that can be rebuilt from canonical notes.
 * Synchronous projections run inline so their writes share the caller's SQLite
 * transaction. Semantic work is queued only after those projections succeed.
 */
export class DerivedIndexCoordinator<Note> {
  readonly #adapter: DerivedIndexAdapter<Note>;
  #queue: Promise<void> = Promise.resolve();
  #indexing = 0;
  #lastError: string | null = null;
  #closed = false;

  constructor(adapter: DerivedIndexAdapter<Note>) {
    this.#adapter = adapter;
  }

  initialize(): void {
    this.#adapter.rebuildSynchronous();
    this.#schedule(this.#adapter.missingSemanticNotes());
  }

  enableSemanticModel(model: EmbeddingModelDescriptor): void {
    if (this.#closed || this.#adapter.model) return;
    this.#adapter.model = model;
    this.#schedule(this.#adapter.missingSemanticNotes());
  }

  replace(note: Note): void {
    this.#adapter.replaceSynchronous(note);
    this.#schedule([note]);
  }

  remove(): void {
    this.#adapter.invalidateSemanticCache?.();
  }

  async wait(): Promise<void> {
    await this.#queue;
  }

  status(): DerivedIndexStatus {
    const totalNotes = this.#adapter.totalNotes();
    const model = this.#adapter.model;
    if (!model) {
      return {
        state: "disabled",
        model: null,
        totalNotes,
        indexedNotes: 0,
        staleNotes: totalNotes,
        lastError: null,
      };
    }
    const indexedNotes = this.#adapter.indexedNotes();
    return {
      state: this.#lastError
        ? "degraded"
        : this.#indexing > 0 || indexedNotes < totalNotes
          ? "indexing"
          : "ready",
      model: { ...model },
      totalNotes,
      indexedNotes,
      staleNotes: Math.max(0, totalNotes - indexedNotes),
      lastError: this.#lastError,
    };
  }

  close(): void {
    this.#closed = true;
  }

  #schedule(notes: readonly Note[]): void {
    if (!this.#adapter.model || this.#closed || notes.length === 0) return;
    this.#adapter.invalidateSemanticCache?.();
    this.#indexing += notes.length;
    this.#queue = this.#queue
      .then(async () => {
        if (this.#closed) return;
        await this.#adapter.indexSemanticNotes(notes, (error) => {
          this.#lastError = errorMessage(error);
        });
        if (this.#adapter.indexedNotes() === this.#adapter.totalNotes()) {
          this.#lastError = null;
        }
      })
      .catch((error) => {
        this.#lastError = errorMessage(error);
      })
      .finally(() => {
        this.#indexing = Math.max(0, this.#indexing - notes.length);
      });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
