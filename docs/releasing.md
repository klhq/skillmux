# Releasing

Release Please creates releases after `main` is green. When its release PR is
merged, the same workflow creates the matching version tag and runs the
publishing jobs directly. The pipeline does not rely on a second workflow being
triggered by a tag created with `GITHUB_TOKEN`, and production environment
secrets do not cross a reusable-workflow boundary.

## Prepare

1. Merge changes to `main` using Conventional Commit titles.
2. Review the Release Please PR, including its version and changelog.
3. Confirm CI passes, then merge the Release Please PR.

## Publish automatically

After the Release Please PR merges, the same workflow run creates the tag and
GitHub Release, then publishes with the exact tag and commit SHA returned by
Release Please. The package version, tag, and commit must all match before
publishing begins.

There is intentionally no tag-push entry point. GitHub does not start a second
workflow for a tag created with the default `GITHUB_TOKEN`; publishing in the
Release Please workflow avoids that event-suppression edge case without adding
a PAT or GitHub App token.

## Exceptional recovery

Use the manual `workflow_dispatch` entry point only to backfill an existing
Release Please tag. The workflow verifies that the tag is clean SemVer,
resolves to the checked-out commit, is reachable from `main`, and still matches
`package.json`. It also requires a matching existing GitHub Release. Manual
backfills never publish npm, so a container or binary recovery cannot
accidentally republish an existing npm version.

The release workflow publishes:

- `skillmux-linux-amd64`
- `skillmux-linux-arm64`
- GitHub build provenance attestations when the repository is public
- Full image to GHCR and Docker Hub: `:<version>`, `:<major>.<minor>`,
  and `:latest`
- Slim image to GHCR and Docker Hub: `:<version>-slim`,
  `:<major>.<minor>-slim`, and `:latest-slim`
- Multi-architecture `linux/amd64` and `linux/arm64` images with SBOM and
  provenance

GHCR is the canonical container build. After both GHCR variants are published,
Docker Hub copies those exact multi-architecture images under its matching
tags. A Docker Hub authentication or availability failure therefore cannot
prevent GHCR from publishing.

Each Docker tag is a multi-architecture manifest. Users run the same tag on
AMD64 and ARM64; Docker automatically pulls the matching image.

The two variants are separate multi-architecture manifests rather than
architecture-suffixed public tags. Docker selects the correct AMD64 or ARM64
image for the host automatically. Pin `:<version>` or `:<version>-slim` for
reproducible deployments; use the floating `latest` tags only when automatic
upgrades are intentional.

Container images are published to:

- `ghcr.io/klhq/skillmux`
- `${DOCKERHUB_USERNAME}/skillmux` on Docker Hub

The `production-release` GitHub environment provides the
`DOCKERHUB_USERNAME` variable and `DOCKERHUB_TOKEN` secret. The npm job also
uses this environment as its Trusted Publisher identity; configure npm with
workflow `release-please.yml` and environment `production-release`. No
long-lived npm token is required. GitHub Packages uses the workflow's scoped
`GITHUB_TOKEN`.
Private repositories still publish BuildKit SBOM/provenance with container
images, but GitHub artifact attestations are skipped because GitHub does not
support them for user-owned private repositories.

Verify downloaded binaries with build provenance attestation:

```bash
gh release download v0.1.1 --repo klhq/skillmux --pattern 'skillmux-linux-*'
gh attestation verify skillmux-linux-amd64 --repo klhq/skillmux
./skillmux-linux-amd64 config show
```

Verify the container with a read-only vault mount:

```bash
docker run --rm \
  -v ~/.agents/skills:/vault:ro \
  -p 3000:3000 \
  ghcr.io/klhq/skillmux:latest

curl --fail http://127.0.0.1:3000/health/ready
```
