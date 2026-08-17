import { describe, expect, test } from "bun:test";
import { runCalibration, type DecisionCase } from "../src/calibrate";

describe("mocked calibration benchmark: serial vs concurrency 4", () => {
  const caseCount = 20;
  const mockLatencyMs = 20;

  const mockCases: DecisionCase[] = Array.from({ length: caseCount }, (_, i) => ({
    query: `benchmark-query-${i}`,
    split: i < caseCount / 2 ? "tune" as const : "test" as const,
    expected_outcome: "matched" as const,
    relevant_skill_ids: [`skill-${i % 4}`],
  }));

  test("compares serial execution (concurrency 1) with concurrency 4", async () => {
    // 1. Serial run (concurrency = 1)
    let inFlightSerial = 0;
    let maxInFlightSerial = 0;

    const t0Serial = performance.now();
    await runCalibration({
      cases: mockCases,
      candidateLimit: 5,
      concurrency: 1,
      reranker: async () => [0.95],
      getRankedCandidates: async (query: string) => {
        inFlightSerial++;
        maxInFlightSerial = Math.max(maxInFlightSerial, inFlightSerial);
        await new Promise((r) => setTimeout(r, mockLatencyMs));
        inFlightSerial--;
        return [{ skill_id: "skill-0", score: 0.95 }];
      },
      minAutoMatchPrecision: 0,
      minRetrievalRecallAtK: 0,
      minDeliveredShortlistRecallAtK: 0,
      minAutoMatchCount: 1,
    });
    const elapsedSerial = performance.now() - t0Serial;

    // 2. Concurrent run (concurrency = 4)
    let inFlightConcurrent = 0;
    let maxInFlightConcurrent = 0;

    const t0Concurrent = performance.now();
    await runCalibration({
      cases: mockCases,
      candidateLimit: 5,
      concurrency: 4,
      reranker: async () => [0.95],
      getRankedCandidates: async (query: string) => {
        inFlightConcurrent++;
        maxInFlightConcurrent = Math.max(maxInFlightConcurrent, inFlightConcurrent);
        await new Promise((r) => setTimeout(r, mockLatencyMs));
        inFlightConcurrent--;
        return [{ skill_id: "skill-0", score: 0.95 }];
      },
      minAutoMatchPrecision: 0,
      minRetrievalRecallAtK: 0,
      minDeliveredShortlistRecallAtK: 0,
      minAutoMatchCount: 1,
    });
    const elapsedConcurrent = performance.now() - t0Concurrent;

    console.log(
      `\n--- Mocked Calibration Benchmark (N=${caseCount}, simulated latency=${mockLatencyMs}ms/case) ---\n` +
      `Serial (concurrency=1):     elapsed=${elapsedSerial.toFixed(1)}ms, max_concurrency=${maxInFlightSerial}\n` +
      `Concurrent (concurrency=4): elapsed=${elapsedConcurrent.toFixed(1)}ms, max_concurrency=${maxInFlightConcurrent}\n` +
      `Speedup factor in mock:     ${(elapsedSerial / elapsedConcurrent).toFixed(2)}x\n` +
      `--------------------------------------------------------------------------------------\n`
    );

    expect(maxInFlightSerial).toBe(1);
    expect(maxInFlightConcurrent).toBe(4);
    expect(elapsedConcurrent).toBeLessThan(elapsedSerial);
  });
});
