# pi-friend

Monorepo for Pi extensions built around friendship-oriented memory and related
agent capabilities.

## Packages

- [`pi-friend-memory`](./packages/pi-friend-memory/) — canonical Markdown memory,
  retrieval, auto-capture, consolidation, and dreaming.

The shared design document remains at
[`pi-friend-memory-spec.md`](./pi-friend-memory-spec.md).

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
