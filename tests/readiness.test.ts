import { describe, expect, test } from "bun:test";
import { ReadinessState } from "../src/readiness";

describe("readiness state", () => {
  test("starts unavailable and returns immutable snapshots", () => {
    const state = new ReadinessState();
    const snapshot = state.get();
    snapshot.status = "ready";

    expect(state.get()).toEqual({
      status: "starting",
      retrieval: null,
      skills: 0,
      index_current: false,
      embedding: "pending",
      reranker: "not_configured",
    });
  });
});
