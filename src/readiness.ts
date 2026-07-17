import type { RetrievalCapability } from "./types";

export interface ReadinessSnapshot {
  status: "starting" | "ready" | "not_ready" | "stopping";
  retrieval: RetrievalCapability | null;
  skills: number;
  index_current: boolean;
  embedding: "pending" | "ready" | "unavailable";
  reranker: "not_configured" | "pending" | "ready" | "unavailable";
  error?: string;
}

export class ReadinessState {
  private snapshot: ReadinessSnapshot = {
    status: "starting",
    retrieval: null,
    skills: 0,
    index_current: false,
    embedding: "pending",
    reranker: "not_configured",
  };

  get(): ReadinessSnapshot {
    return { ...this.snapshot };
  }

  set(snapshot: ReadinessSnapshot): void {
    this.snapshot = { ...snapshot };
  }
}
