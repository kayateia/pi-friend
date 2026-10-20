# pi-friend-memory

A friendship-oriented memory extension for the Pi coding agent. The current
skeleton provides a single `/hello` command to verify that the package and its
extension entry point load successfully.

The storage foundation, strict node schema validation, parsed-node repository,
and initial `memory_add` / `memory_read` tools are implemented. Retrieval and
prompt injection are still upcoming.

## Package layout

Pi loads the extension from the root-level composition entry:

```text
index.ts   # Pi-facing hooks, commands, and tool registrations
src/       # Configuration, storage, and implementation modules
```

## Memory storage

The default tree is:

```text
~/.pi/agent/pi-friend/memory/
├── MEMORY.md
├── nodes/
│   └── superseded/
├── staging/
├── daily/
├── access-log
├── sweeps/
├── index/
└── recovery/
```

Override the root in `~/.pi/agent/pi-friend/pi-friend.yml`:

```yaml
memory:
  root: ~/workspace/memory
```

A missing config uses the default. Malformed configuration is reported and
does not fall back to another path. The tree is initialized on `session_start`.

## Development

Install the development dependencies:

```sh
npm install
```

Type-check the extension:

```sh
npm run typecheck
```

Run the storage tests:

```sh
npm test
```

Load the extension directly from the working tree:

```sh
pi --extension ./index.ts
```

Then run `/hello` to greet the world or `/hello Aisling` to greet someone by
name. Pi compiles TypeScript extensions itself, so no build step is required.

## Install locally

Install this checkout as a Pi package:

```sh
pi install ./
```

Pi reads the extension entry point from the `pi.extensions` field in
`package.json`.

## Memory tools

- `memory_add` creates a canonical active node, derives a unique slug unless one
  is supplied, and records speaker attribution.
- `memory_edit` updates an existing node while preserving creation and usage
  metadata and appending a dated audit entry.
- `memory_read` reads a complete node from canonical, staging, or superseded
  storage.

Supersession through `memory_add` is intentionally deferred until correction
handling can update both sides of the relationship atomically.

## Inspect lifecycle hooks

Set `PI_FRIEND_DEBUG_HOOKS=1` when starting Pi to print each structural
lifecycle event and its shared extension context with `console.log`:

```sh
PI_FRIEND_DEBUG_HOOKS=1 pi --extension ./index.ts
```

The logger includes session, agent, turn, prompt, provider, tool, input, model,
and UI boundaries. It intentionally omits token-level streaming updates.
