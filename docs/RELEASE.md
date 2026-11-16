# Releasing `modelapp`

The package is **not published**: the owner has not approved publishing to npm. This page is what makes and checks
the tarball today, and the exact steps for publish day.

## What ships

- In the repository, `packages/modelapp/package.json` exports TypeScript source (`./src/index.ts`, …) and stays
  `"private": true`. The examples, Clegra's node and the tests import it through the workspace, with no build step.
- `npm pack` (its `prepack`, `scripts/prepack.mjs`) builds `dist/` with `tsc` (`scripts/build.mjs`: ESM JavaScript,
  `.d.ts`, source maps with the sources inlined; relative imports get their `.js`; the JSON Schema and `kinds.json`
  copied next to the code that reads them; the CLI with a `node` shebang). It copies `docs/map/CHANGELOG.md` in as
  `CHANGELOG.md`. Then it packs a package.json whose exports are `{ types, default }` in `dist/`, whose `bin` is
  `dist/spec/src/cli.js`, without scripts or devDependencies. `postpack` puts the repository's package.json back.
  `dist/` is git-ignored.
- Entries: `modelapp`, `modelapp/next`, `modelapp/node`, `modelapp/testing`, `modelapp/spec`,
  `modelapp/modelapp.schema.json`, `modelapp/kinds.json`, `modelapp/package.json`; the CLI `modelapp`
  (`check`, `init`).
- Dependencies: `@modelcontextprotocol/server`, `ajv`, `jose`. Peers: `zod` 4, `next` 15+ (optional: only
  `modelapp/next` imports it, as types). To decide before publishing: `zod` `^4.2.0`, the MCP SDK's own range
  (it depends on zod ^4.2.0; an app on zod 4.0/4.1 gets a second copy for the SDK).
- Files: `dist`, `README.md`, `LICENSE` (MIT, «Copyright (c) 2026 Clegra»), `CHANGELOG.md`, `package.json`.

## The guard

- `npm publish` from `packages/modelapp` is refused by `prepack` with the way to release (npm itself would refuse it
  too: the repository's package.json is private).
- A tarball made by plain `npm pack` keeps `"private": true`: `npm publish <that tarball>` fails with `EPRIVATE`.
  It installs as any other package.
- Only `MODELAPP_PUBLISH=approved npm pack` makes a tarball without `private`.
- `npm publish --dry-run`, in the folder or on a tarball, runs everything and uploads nothing.

## The pack check

```sh
cd packages/modelapp
npm run pack:check -- --dir /some/empty/folder/outside/the/repo --port 3946
```

Slow (one `npm install`, `next dev`, `next build`; about 30 s on a warm npm cache), so not in `npm test`. It packs
the tarball and checks its files and package.json, that every relative import in `dist` resolves inside the tarball,
the public packages' hygiene check, and the guard (EPRIVATE against a closed local port, nothing leaves the
machine). Then, in a fresh Next.js App Router app (the repository's Next, React and TypeScript versions) with the
tarball installed: `npx modelapp init`, `next dev` + `npx modelapp check --token <the local bearer>`, `next build`
+ `next start` + `npx modelapp check` (the local bearer refused in production), a plain Node ESM script importing
every entry and running an app with `testClient`, and `tsc` with `moduleResolution` `bundler` and `node16`
(modelapp's own `.d.ts` with `skipLibCheck` off). The folder must have no `node_modules` or `package.json` above it.
It uses `--port` and `--port + 1` (and `--port + 2`, a closed port, for the guard). `--keep` keeps the app's
`node_modules`.

## Publish day (after the owner's yes)

Decided (owner, 2026-11-16): the unscoped name `modelapp` (no scope), first version `0.1.0`, MIT. The name was
free on 2026-11-16 (`npm view modelapp` answered 404). Still open, not blocking: a public home for the spec and the
code (`repository`, `homepage`, `bugs`; the README's links to `docs/map/*.md` point inside this repository today).

Publish from the branch that has the build (`packages/modelapp/scripts/prepack.mjs`): a package.json that still
exports `./src/*.ts` with no `prepack` would publish TypeScript source.

```sh
cd packages/modelapp
npm run typecheck && npm test && npm run pack:check -- --dir "$(mktemp -d /tmp/pc.XXXX)"
npm whoami                                        # the account that will own the package
mkdir -p /tmp/modelapp-release
MODELAPP_PUBLISH=approved npm pack --pack-destination /tmp/modelapp-release
npm publish --dry-run /tmp/modelapp-release/modelapp-0.1.0.tgz    # read the file list once more
npm publish --access public /tmp/modelapp-release/modelapp-0.1.0.tgz
```

`/tmp` (not the scratch folder of a session) has no `package.json` above it. A new version: bump `version` in
`packages/modelapp/package.json`, move the changelog's «Unreleased» to the version, then the same steps.
