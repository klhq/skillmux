# Releasing

Releases are created from version tags after `main` is green.

## Prepare

1. Update `version` in `package.json`.
2. Move relevant entries from `Unreleased` into a dated version section in `CHANGELOG.md`.
3. Merge those changes through a pull request and confirm CI passes.

## Publish

Create and push the matching tag:

```bash
git switch main
git pull --ff-only
git tag v0.1.1
git push origin v0.1.1
```

The tag must exactly match `v` plus the `package.json` version. A mismatch stops the release.

The release workflow publishes:

- `skillmux-linux-amd64`
- `skillmux-linux-arm64`
- `SHA256SUMS`
- GitHub build provenance attestations when the repository is public
- Full image: `:<version>`, `:<major>.<minor>`, `:<major>`, and `:latest`
- Slim image: `:<version>-slim`, `:<major>.<minor>-slim`, `:<major>-slim`, and `:latest-slim`
- Multi-architecture `linux/amd64` and `linux/arm64` images with SBOM and provenance

Each Docker tag is a multi-architecture manifest. Users run the same tag on AMD64 and ARM64; Docker automatically pulls the matching image.

Container images are published to GitHub Container Registry only; the release workflow does not require external registry credentials.
Private repositories still publish BuildKit SBOM/provenance with container images, but GitHub artifact attestations are skipped because GitHub does not support them for user-owned private repositories.

Verify downloaded binaries with:

```bash
sha256sum --check SHA256SUMS
./skillmux-linux-amd64 config show
```

Verify release assets from GitHub without cloning the repository:

```bash
gh release download v0.1.1 --repo klhq/skillmux
sha256sum --check SHA256SUMS
```

Verify the container with a read-only vault mount:

```bash
docker run --rm \
  -v ~/.agents/skills:/vault:ro \
  -p 3000:3000 \
  ghcr.io/klhq/skillmux:latest

curl --fail http://127.0.0.1:3000/health/ready
```
