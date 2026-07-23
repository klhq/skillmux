# Releasing

Releases are initiated by manually pushing a clean SemVer tag whose commit
belongs to `main`. The tag-triggered workflow validates the version and commit,
then publishes every release artifact in one run.

## Prepare

1. Update `version` in `package.json`.
2. Move relevant entries from `Unreleased` into a dated version section in `CHANGELOG.md`.
3. Merge those changes through a pull request and confirm CI passes.

## Publish

```bash
git switch main
git pull --ff-only
git tag -a v0.1.1 -m "Release v0.1.1"
git push origin v0.1.1
```

The tag must match `v` plus the `package.json` version exactly. Tags that do not
point to a commit reachable from `main` are rejected before anything publishes.

The release workflow publishes:

- The npm package
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
