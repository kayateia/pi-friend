# pi-friend-memory

A memory extension for the Pi coding agent. The current skeleton provides a
single `/hello` command to verify that the extension loads successfully.

## Development

Install the development dependencies:

```sh
npm install
```

Type-check the extension:

```sh
npm run typecheck
```

Load the extension directly into Pi:

```sh
pi --extension ./src/index.ts
```

Then run `/hello` to greet the world or `/hello Aisling` to greet someone by
name. Pi compiles TypeScript extensions itself, so no build step is required.
