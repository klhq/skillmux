# Specification: Privacy Cleanup & Synthetic Generator for Calibration Tuning

## Goal
Sanitize the open-source repository by replacing real skill queries in `eval/queries.json` with synthetic mock queries, and add a local synthetic dataset generator (`generateDataset`) to build vault-tailored calibration datasets on demand. Clean up the PR commit history on `feat/calibration-tuning` starting from `origin/main` so that private data never existed in the Git history.

---

## Acceptance Criteria

### AC1 — Checked-in Repo Dataset Sanitization
- `eval/queries.json` is sanitized to use generic synthetic mock queries and skill IDs (`mock-skill-a`, `mock-skill-b`, `mock-skill-c`, etc.) that do not reference any real or private skill names.
- All existing tests in `tests/calibrate.test.ts` and `tests/eval.test.ts` pass cleanly with the sanitized dataset.
- `.gitignore` is updated so that user-generated datasets (e.g. `*.dataset.json`, local state datasets) are never committed.

### AC2 — Synthetic Dataset Generator Core (`generateDataset`)
- `generateDataset(skills: VaultSkill[], options?: GenerateDatasetOptions)` generates a valid decision-policy dataset from any set of local skill definitions.
- Generates all 3 outcome types:
  1. `matched`: Synthetic queries targeted at individual skills using title, description, and alias variants (`relevant_skill_ids` has length 1).
  2. `ambiguous`: Synthetic queries targeting overlapping concepts across multiple skills (`relevant_skill_ids` has length $\ge 2$).
  3. `no_match`: Generic out-of-domain synthetic queries (`relevant_skill_ids` is `[]`).
- Shuffles and splits generated cases 50/50 into `tune` and `test` splits while maintaining balanced proportions of all 3 outcome types across both splits.

### AC3 — CLI Integration (`skillmux calibrate generate-dataset`)
- Command `skillmux calibrate generate-dataset [--vault <path>] [--out <file>]` scans local skills and writes the generated decision dataset JSON to `--out` (defaulting to `state_dir/queries.json`).

### AC4 — Clean Git History (PR Commit Cleanup)
- Interactive rebase/reset from `origin/main` squashes and sanitizes the feature branch commits on `feat/calibration-tuning`.
- Re-pushes clean commits to `origin/feat/calibration-tuning` using `git push --force-with-lease`.
- The final PR contains zero traces or historical revisions of private skill queries in its commit history.

---

## Plan of Execution

1. **Step 1: Sanitize Dataset**: Update `eval/queries.json` to use synthetic mock skill IDs (`mock-skill-a`, `mock-skill-b`, etc.) and generic queries.
2. **Step 2: Add Generator**: Implement `src/dataset-generator.ts` and unit tests in `tests/dataset-generator.test.ts`.
3. **Step 3: Update Specs & Docs**: Update `docs/sdd/calibration-tuning/spec.md`.
4. **Step 4: Verify Tests**: Run full test suite (`bun test`) ensuring 100% pass rate across all files.
5. **Step 5: Clean PR History**: Soft-reset or rebase commits relative to `origin/main`, re-commit clean atomic commits, and push with `--force-with-lease` to update PR #35.
