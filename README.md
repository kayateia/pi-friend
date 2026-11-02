# pi-friend

Monorepo for Pi extensions built around friendship-oriented memory and related
agent capabilities.

## Packages

- [`pi-friend-memory`](./packages/pi-friend-memory/) — canonical Markdown memory,
  retrieval, auto-capture, consolidation, and dreaming.
- [`pi-friend-prompt`](./packages/pi-friend-prompt/) — configurable edits to
  Pi's generated system prompt.

The shared design document remains at
[`docs/pi-friend-memory-spec.md`](./docs/pi-friend-memory-spec.md).

The memory extension reads:

```text
~/.pi/agent/pi-friend/pi-friend-memory.yml
```

The prompt extension continues to read:

```text
~/.pi/agent/pi-friend/pi-friend.yml
```

See [`pi-friend-memory.example.yml`](./pi-friend-memory.example.yml) and
[`pi-friend-prompt.example.yml`](./packages/pi-friend-prompt/pi-friend-prompt.example.yml)
for the package examples.

## Development

Install all workspace dependencies from the repository root:

```sh
npm install
```

Type-check and test every package:

```sh
npm run typecheck
npm test
```

Work on one package:

```sh
npm test --workspace pi-friend-memory
npm run typecheck --workspace pi-friend-memory
npm test --workspace pi-friend-prompt
npm run typecheck --workspace pi-friend-prompt
```

## Using the memory extension

Load it directly during development:

```sh
pi --extension ./packages/pi-friend-memory/index.ts
```

Install the package from its package directory:

```sh
pi install ./packages/pi-friend-memory
```

## Using the prompt extension

Load it directly during development:

```sh
pi --extension ./packages/pi-friend-prompt/index.ts
```

Install the package from its package directory:

```sh
pi install ./packages/pi-friend-prompt
```
