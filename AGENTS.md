## Overview

This project represents a memory extension for the pi.dev AI harness.

Full information about [pi.dev plugins and practices](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)

The design of what we want to build is in pi-friend-memory-spec.md in this directory.

## Needed files

All needed files are located in this project directory and `~/.pi`. Don't go searching for other files elsewhere. Don't use `find $HOME` or similar tactics.

## Code standards

- Use 2-space indents
- Write comments anywhere they could assist in understanding, especially on methods/functions and classes.
- Do not use `any` or other typecheck defeating primitives

## Source control

Use git, rooted in the project directory (here). Commit early and often with conventional commits.

## Building

Building the project before deployment is actually not necessary; Pi itself does this. However,
a package.json for utilities like linting and testing is useful.

## Testing

Tests may simply pull in the pi.dev main package (@earendil-works/pi-coding-agent) and go from there.

For smaller unit tests, another method may be needed (e.g. tsnode).

