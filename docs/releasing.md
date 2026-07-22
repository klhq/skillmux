# Releasing

Release Please creates releases after `main` is green. When its release PR is
merged, it creates the matching version tag and directly calls the reusable
release workflow. The pipeline does not rely on a second workflow being
triggered by a tag created with `GITHUB_TOKEN`.

## Prepare

1. Update `version` in `package.json`.
2. Move relevant entries from `Unreleased` into a dated version section in `CHANGELOG.md`.
3. Merge those changes through a pull request and confirm CI passes.

## Publish automatically

Merge the Release Please PR. The package version and generated tag must match
exactly (`v` plus the `package.json` version). A mismatch stops the release.

## Publish or backfill manually

For an existing tag that was not published, run the `Release` workflow from
GitHub Actions with `release_tag` set to the exact tag, for example `v0.4.0`.
Backfill missed releases oldest-first so floating tags such as `latest` finish
on the newest version.

For a new manual release, create and push the matching tag:

```bash
git switch main
git pull --ff-only
git tag v0.1.1
git push origin v0.1.1
```

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

The workflow requires the repository variable `DOCKERHUB_USERNAME` and secrets
`DOCKERHUB_TOKEN` and `NPM_TOKEN`. GitHub Packages uses the workflow's scoped
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
