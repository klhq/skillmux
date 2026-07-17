import { describe, expect, test } from "bun:test";
import { reciprocalRankFusion } from "../src/rrf";

describe("reciprocal rank fusion", () => {
  test("promotes candidates supported by both retrieval lanes", () => {
    const lexical = [{ skill_id: "a" }, { skill_id: "b" }, { skill_id: "c" }];
    const semantic = [{ skill_id: "b" }, { skill_id: "a" }, { skill_id: "d" }];

    expect(reciprocalRankFusion(lexical, semantic).map((item) => item.skill_id)).toEqual(["b", "a", "d", "c"]);
  });
});
