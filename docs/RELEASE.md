# Releasing `@clegra/sdk`

The package is this repository's root. Versions before 1.0 are prereleases on the dist-tag `next`
(`0.1.0-next.0` first; `0.4.0-next.0` the first on the MCP extensions). This page is what the tarball holds, how it is checked, and the publish steps.

## What ships

- In the repository, `package.json` exports TypeScript source (`./src/index.ts`, …). The tests import it with no build
  step.
- `npm pack` (its `prepack`, `scripts/prepack.mjs`) builds `dist/` with `tsc` (`scripts/build.mjs`: ESM JavaScript,
  `.d.ts`, source maps with the sources inlined; relative imports get their `.js`; the CLI with a `node` shebang).
  Only `src/` is built (`dist/src/…`); there is no `spec/` folder any more. Then it swaps in the published
  package.json: exports `{ types, default }` in `dist/`, `bin` `clegra` → `dist/src/cli/index.js`, no
  devDependencies, workspaces or overrides, and of the scripts only `postpublish`. `postpack` (or, during a real
  publish, `postpublish`) puts the repository's package.json back: npm re-reads package.json after packing and
  uploads that as the version's metadata, so it must still be the published one at that moment. `dist/` is
  git-ignored.
- Entries: `@clegra/sdk`, `@clegra/sdk/signin`, `@clegra/sdk/next`, `@clegra/sdk/node`, `@clegra/sdk/express`,
  `@clegra/sdk/testing`, `@clegra/sdk/package.json`; the CLI `clegra` (`npx @clegra/sdk check`, `npx @clegra/sdk
  init`).
- Dependencies: `@modelcontextprotocol/server` (the MCP server and its Skills extension), `jose`. Peers: `zod` 4 and
  `next` 15+ (optional: only `@clegra/sdk/next` uses it). No UI library and no `@clegra/ui`.
- `publishConfig.access: public` (a scoped package is private by default).
- Files: `dist`, `docs/spec.md`, `docs/start-javascript.md`, `docs/start-next.md`, `docs/accents.svg`,
  `docs/extensions/*.md` (the normative extension documents; read from the installed package, e.g. by Clegra's site:
  `node_modules/@clegra/sdk/docs/…`), `README.md`, `LICENSE` (MIT, «Copyright (c) 2026 Clegra»), `NOTICE.md`,
  `CHANGELOG.md`, `package.json`. Not: the other docs, `scripts/`, tests.

## The guard

- A prerelease (`0.1.0-next.0`) is published with a dist-tag only, so it never becomes `latest`. npm refuses
  `npm publish` of a prerelease without `--tag` unless `--force`; `prepack` refuses it too, before anything is
  built, with `--force` or not.
- `npm publish --dry-run --tag next` runs everything (build, swap, restore) and uploads nothing.
- If a real publish fails after packing (network, authentication, a version that exists), package.json may still be
  the published one: `node scripts/postpack.mjs` puts the repository's back (`git status` shows it). `prepack`
  refuses to start while `.package.repo.json` is there.

## The pack check

```sh
# once: the @clegra/ui tarball beside this package (git-ignored)
npm pack @clegra/ui@next --pack-destination vendor
npm run pack:check -- --dir "$(mktemp -d /tmp/clegra-pack.XXXX)" --port 3946
```

Slow (four `npm install`s, `next dev`, two `next build`s), so not in `npm test`. It packs the tarball and checks its
files and package.json (`@clegra/sdk`, public, the bin `clegra`, every export target in the tarball, `types` before
`default`, no UI entry, peers `zod` and optional `next` only), that every relative import in `dist` resolves inside
the tarball, the hygiene check where it is available (no private name, private path, secret or pre-split package
name), and the guard (a dry-run publish without a tag is refused; with `--tag next` it passes,
public access; nothing leaves the machine). Then:

1. a Node-only app (the tarball and zod): no React, Next or UI library in its tree; `@clegra/sdk` and
   `@clegra/sdk/node` imported and run;
2. a fresh Next.js App Router app with the tarball: `npx @clegra/sdk init`, `next dev` + `npx @clegra/sdk check
   --token <a development token>`, `next build` + `next start` + `npx @clegra/sdk check` (development tokens refused
   in production);
3. a plain Node ESM script importing every entry, running an app with `testClient`; `tsc` with `moduleResolution`
   `bundler` and `node16` (the package's own `.d.ts` with `skipLibCheck` off);
4. both packages: a fresh Next.js app with Tailwind 4 and both tarballs, init's `--ui` library list equal to the
   `@clegra/ui` tarball's web peers and `UI_RANGE` naming its version, `npx @clegra/sdk init --ui` + `npm install`,
   a page with Button, Card and the Sidebar, `next build` + `next start` (rendered, the theme and the components'
   classes in the stylesheet), `npx @clegra/sdk check`.

The folder must have no `node_modules` or `package.json` above it. It uses `--port` to `--port + 2`. `--keep` keeps
the apps' `node_modules`.

## Publishing

Two scoped packages in the npm organisation `clegra`: `@clegra/sdk` (this repository) and `@clegra/ui` (a separate
package and repository), MIT, versions before 1.0 on the dist-tag `next`. Publish `@clegra/ui` first when `init --ui`
names a new version of it.

This repository is a snapshot of the package at each version. Its `.github/workflows/publish.yml` runs on a push to
`main` that changes `package.json`: when that version is not on npm yet it runs `npm ci`, `npm pack` (printing the
tarball's integrity) and publishes that tarball with `npm publish <tarball> --tag next|latest --access public
--provenance`, through npm's Trusted Publishing (OIDC: no token anywhere). The provenance statement on npm links the
version to the commit and the run that built it. The pack is reproducible: the same commit packs to the same bytes
anywhere (same Node major and npm).

Before a snapshot is pushed, where the package is developed:

```sh
npm ci
npm run typecheck && npm test
npm run pack:check -- --dir "$(mktemp -d /tmp/clegra-pack.XXXX)"
npm publish --dry-run --tag next # read the file list once more; uploads nothing
```

A new version: bump `version` in package.json, move the changelog's «Unreleased» to the version, then the snapshot
(tagged `v<version>` here). When `@clegra/ui` moves to a version outside `UI_RANGE`, raise it (and the library list)
in the init's UI module (`src/init/`); the pack check fails until they match the tarball in `vendor/`.
