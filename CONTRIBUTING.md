# Contributing to skillmux

Thank you for your interest in contributing to `skillmux`! This document outlines our development workflows, coding standards, and repository conventions.

Product and operator documentation starts at [`docs/README.md`](docs/README.md).

## Development Setup

We use **Bun** for both runtime execution and package management.

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.3
- [Docker](https://www.docker.com/) (optional, for container builds)

### Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/klhq/skillmux.git
cd skillmux
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
docker build --target slim -t skillmux:dev-slim .

# Build the full variant with bundled GTE-small
docker build --target full -t skillmux:dev .
```

To test the container locally:

```bash
docker run --rm -v ~/skills:/vault:ro -p 3000:3000 skillmux:dev
```

## Contribution Workflow

1. **Describe the change first**: For non-trivial features, agree on observable behavior and scope in the issue or pull request before coding.
2. **Follow TDD**: Implement failing tests representing your spec's acceptance criteria before writing the code.
3. **Commit Convention**: We follow [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat: ...` for new features
   - `fix: ...` for bug fixes
   - `docs: ...` for documentation changes
   - `test: ...` for adding or modifying tests
4. **MCP Tool Schemas (GBNF Safety)**: Tool `inputSchema` declarations are not only validation metadata. Clients that do constrained decoding compile them into a sampling grammar. Keep wire schemas structural (e.g. `z.string().min(1)`) and put value length or range validation in the handler instead. Do not place numeric bounds (`.max(n)`, `maxItems`, `maximum`) or regex quantifiers (`{n,m}`) above a few hundred on an `inputSchema` field.

   The counterintuitive part: an *unbounded* string is cheaper than a bounded one. llama.cpp compiles `z.string()` to `char+`, one rule, but `.max(8192)` to `char{1,8192}`, which its GBNF parser expands and then rejects against `MAX_REPETITION_THRESHOLD` (2000, in `src/llama-grammar.cpp`); measured on `gpt-oss-20b`, 1999 succeeds and 2000 fails. This happens at sampler initialization, before any request data is seen, so it fires regardless of how long the actual value is, and it kills the whole combined grammar: one oversized field in one tool breaks tool-calling for every other MCP server mounted alongside it. The failure surfaces only as `HTTP 400 Failed to initialize samplers: failed to parse grammar`, with no indication of which tool caused it. `tests/guarantees.test.ts` enforces this automatically at a conservative threshold of 500, since other decoders (vLLM, Ollama) have their own undocumented limits.
5. **Code Quality**: Write type-safe TypeScript. Do not disable strict compiler flags.

Pull requests run the test suite, TypeScript validation, compiled binary build, JSON Schema validation, and a slim Docker image build. Release procedure is documented in [`docs/releasing.md`](docs/releasing.md).
