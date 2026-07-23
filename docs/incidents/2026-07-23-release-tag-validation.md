# Incident: Release tag validation blocked all publishers

**Started:** 2026-07-23T02:16:17+08:00
**Resolved:** Pending
**Duration:** Ongoing
**Path:** forward-fix

## What broke

The `v0.4.1` release reached the reusable release workflow, but every publish
job failed at the version preflight. The workflow attempted to override the
reserved `GITHUB_REF_NAME` variable with the release tag; GitHub retained the
caller ref `main`, which the SemVer guard rejected.

## Impact

- **Who:** npm, GHCR, Docker Hub, and GitHub Release consumers
- **What:** Full release outage for `v0.4.1`; no package, container, or binary
  publisher ran

## Timeline

- 02:16 — Release Please created `v0.4.1` and invoked publishing
- 02:16 — All publish lanes failed at `Verify tag matches package version`
- 02:28 — Root cause isolated to the reserved `GITHUB_REF_NAME` override
- 02:35 — Forward-fix branch opened
- 02:53 — First forward-fix merged with green CI
- 12:01 — Backfill exposed that checking out `v0.4.1` also restored the old
  helper script from the tag
- 12:02 — Follow-up fix moved validation into the current workflow definition

## Resolution

The forward-fix makes the version guard consume the workflow's explicit
`RELEASE_TAG` value and retains `GITHUB_REF_NAME` only as a fallback for direct
tag invocations. The attempted reserved-variable overrides were removed. A
follow-up moved the release gate inline so historical-tag backfills cannot
restore an obsolete validation helper during checkout.

## Follow-ups

- [ ] Add regression coverage for reusable and direct-tag release contexts
- [ ] Complete the npm OIDC and protected-environment migration separately
- [ ] Backfill `v0.4.1` after the corrected workflow reaches `main`
