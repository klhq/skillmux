# Contributing to skill-router

Thank you for your interest in contributing to `skill-router`! This document outlines our development workflows, coding standards, and repository conventions.

## Development Setup

We use **Bun** for both runtime execution and package management.

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.3
- [Docker](https://www.docker.com/) (optional, for container builds)

### Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/klhq/skill-router.git
cd skill-router
bun install
```

Ensure native binaries are trusted so `onnxruntime-node` downloads correct C++ bindings:

```bash
bun pm trust onnxruntime-node
bun pm trust protobufjs
bun install
```

## Running the CLI

You can run commands directly using the Bun runtime:

```bash
# Serve the stdio server (default)
bun run src/cli.ts serve

# Serve the HTTP server
bun run src/cli.ts serve --transport http --port 3000

# Rebuild the local index
bun run src/cli.ts index

# Run calibration evaluation
bun run src/cli.ts eval
```

## Testing

We use Bun's built-in testing framework (`bun:test`). All tests must pass before making a pull request.

```bash
# Run the entire test suite
bun test

# Run a specific test file
bun test tests/onnx-clients.test.ts
```

### Writing Tests

- Unit tests belong in the `tests/` directory and should be named `*.test.ts`.
- Ensure new features have accompanying tests.
- For local ONNX inference, verify tests work offline or use cached models.

## Docker Builds

To package the application into Docker container variants:

```bash
# Build the slim variant (remote embeddings or lexical fallback)
docker build --target slim -t skill-router:dev-slim .

# Build the full battery-included variant
docker build --target full -t skill-router:dev .
```

To test the container locally:

```bash
docker run --rm -v ~/.agents/skills:/vault:ro -p 3000:3000 skill-router:dev
```

## Contribution Workflow

1. **Describe the change first**: For non-trivial features, agree on observable behavior and scope in the issue or pull request before coding.
2. **Follow TDD**: Implement failing tests representing your spec's acceptance criteria before writing the code.
3. **Commit Convention**: We follow [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat: ...` for new features
   - `fix: ...` for bug fixes
   - `docs: ...` for documentation changes
   - `test: ...` for adding or modifying tests
4. **Code Quality**: Write type-safe TypeScript. Do not disable strict compiler flags.

Pull requests run the test suite, TypeScript validation, compiled binary build, JSON Schema validation, and a slim Docker image build. Release procedure is documented in [`docs/releasing.md`](docs/releasing.md).
