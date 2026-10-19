# pi-friend-memory

A friendship-oriented memory extension for the Pi coding agent. The current
skeleton provides a single `/hello` command to verify that the package and its
extension entry point load successfully.

Memory schema, storage, retrieval, and production lifecycle behavior have not
been implemented yet.

## Package layout

Pi loads the extension from the root-level composition entry:

```text
index.ts   # Pi-facing hooks, commands, and tool registrations
src/       # Implementation modules added as memory behavior is built
```

## Development

Install the development dependencies:

```sh
npm install
```

Type-check the extension:

```sh
npm run typecheck
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

## Inspect lifecycle hooks

Set `PI_FRIEND_DEBUG_HOOKS=1` when starting Pi to print each structural
lifecycle event and its shared extension context with `console.log`:

```sh
PI_FRIEND_DEBUG_HOOKS=1 pi --extension ./index.ts
```

The logger includes session, agent, turn, prompt, provider, tool, input, model,
and UI boundaries. It intentionally omits token-level streaming updates.
