# pi-friend-memory

A friendship-oriented memory extension for the Pi coding agent.

The storage foundation, strict schema, repository, memory lifecycle tools,
keyword and semantic search, and sqlite-vec indexing are implemented. Prompt
injection is still upcoming.

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
- `memory_delete` moves exactly one matched node into superseded storage after
  writing a durable recovery record.
- `memory_restore` restores a deleted node from its recovery ID without
  overwriting newer canonical content.
- `memory_read` reads a complete node from canonical, staging, or superseded
  storage.
- `memory_search` supports ranked keyword search and semantic search across
  nodes, staging candidates, and plain Markdown documents.

Supersession through `memory_add` is intentionally deferred until correction
handling can update both sides of the relationship atomically.

## Semantic search

The `index/` directory includes a disposable `sqlite-vec` backend backed by
Node's built-in SQLite runtime. It supports transactional upsert, removal,
cosine search, clearing, and rebuild against a declared embedding model and
dimension count.

Semantic mode uses Pi's stored OpenRouter credential, falling back to
`OPENROUTER_API_KEY`, and embeds with `openai/text-embedding-3-small` at 1,536
dimensions. Markdown is synchronized lazily on semantic search; unchanged
content hashes do not make repeat embedding calls.

The Markdown tree remains canonical. Deleting `index/vectors.sqlite` is always
safe because the index can be rebuilt from source files. Hybrid ranking is not
implemented yet.

## Inspect lifecycle hooks

Set `PI_FRIEND_DEBUG_HOOKS=1` when starting Pi to print each structural
lifecycle event and its shared extension context with `console.log`:

```sh
PI_FRIEND_DEBUG_HOOKS=1 pi --extension ./index.ts
```

The logger includes session, agent, turn, prompt, provider, tool, input, model,
and UI boundaries. It intentionally omits token-level streaming updates.
