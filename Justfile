set script-interpreter := ["bash", "-eu", "-o", "pipefail"]
set positional-arguments

bun := require("bun")
tooling := "../pi-extension-kit/scripts/tooling.ts"

# List available recipes.
default:
  @just --list --justfile '{{justfile()}}'

# Install JavaScript development dependencies.
sync:
  {{bun}} install

# Build and validate the pi extension runtime bundle.
build: clean compile test lint
  {{bun}} {{tooling}} package

# Remove generated build artifacts.
clean: sync
  {{bun}} {{tooling}} clean

# Type-check TypeScript sources.
compile: sync
  {{bun}} {{tooling}} compile

# Install the built managed extension artifact.
install: build
  {{bun}} {{tooling}} install

# Apply Biome checks, formatting, and source fixes. Optional paths narrow the check scope.
[script]
lint *paths: sync
  {{bun}} {{tooling}} lint "$@"

# Run Bun tests. Optional paths narrow the test scope.
[script]
test *paths: sync
  {{bun}} {{tooling}} test "$@"
