# Releasing `@clegra/sdk`

The package is this repository's root. Versions before 1.0 are prereleases on the dist-tag `next`
(`0.1.0-next.0` first). This page is what the tarball holds, how it is checked, and the publish steps.

## What ships

- In the repository, `package.json` exports TypeScript source (`./src/index.ts`, …). The examples (npm workspaces of
  this repository, depending on `@clegra/sdk` as `file:../..`) and the tests import it with no build step.
- `npm pack` (its `prepack`, `scripts/prepack.mjs`) builds `dist/` with `tsc` (`scripts/build.mjs`: ESM JavaScript,
  `.d.ts`, source maps with the sources inlined; relative imports get their `.js`; the JSON Schema and `kinds.json`
  copied next to the code that reads them; the CLI with a `node` shebang). Then it swaps in the published package.json:
  exports `{ types, default }` in `dist/`, `bin` `clegra` → `dist/spec/src/cli.js`, no devDependencies, workspaces or
  overrides, and of the scripts only `postpublish`. `postpack` (or, during a real publish, `postpublish`) puts the
  repository's package.json back: npm re-reads package.json after packing and uploads that as the version's
  metadata, so it must still be the published one at that moment. `dist/` is git-ignored.
- Entries: `@clegra/sdk`, `@clegra/sdk/next`, `@clegra/sdk/node`, `@clegra/sdk/testing`, `@clegra/sdk/spec`,
  `@clegra/sdk/clegra.schema.json`, `@clegra/sdk/kinds.json`, `@clegra/sdk/package.json`; the CLI `clegra`
  (`npx @clegra/sdk check`, `npx @clegra/sdk init [--ui]`).
- Dependencies: `@modelcontextprotocol/server`, `ajv`, `jose`. Peers: `zod` 4 and `next` 15+ (optional: only
  `@clegra/sdk/next` imports it, as types). No UI library and no `@clegra/ui`: the generated MCP Apps view is plain
  HTML; `init --ui` adds `@clegra/ui` (at `UI_RANGE`, `spec/src/init/ui.ts`) and its web libraries to the app.
  To decide before publishing: `zod` `^4.2.0`, the MCP SDK's own range (it depends on zod ^4.2.0; an app on zod
  4.0/4.1 gets a second copy for the SDK).
- `publishConfig.access: public` (a scoped package is private by default).
- Files: `dist`, `docs/spec.md` and `docs/quickstart.md` (read from the installed package, e.g. by Clegra's site:
  `node_modules/@clegra/sdk/docs/{spec,quickstart}.md`), `README.md`, `LICENSE` (MIT, «Copyright (c) 2026 Clegra»),
  `NOTICE.md`, `CHANGELOG.md`, `package.json`. Not: `examples/`, the other docs, `scripts/`, tests.

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
(cd ../clegra-ui && npm pack --pack-destination ../clegra-sdk/vendor)   # or, once published: npm pack @clegra/ui@next --pack-destination vendor
npm run pack:check -- --dir "$(mktemp -d /tmp/clegra-pack.XXXX)" --port 3946
```

Slow (four `npm install`s, `next dev`, two `next build`s), so not in `npm test`. It packs the tarball and checks its
files and package.json (`@clegra/sdk`, public, the bin `clegra`, every export target in the tarball, `types` before
`default`, no UI entry, peers `zod` and optional `next` only), that every relative import in `dist` resolves inside
the tarball, the hygiene check (`scripts/hygiene.mjs`: no private or customer name, private repository path, secret
or pre-split package name), and the guard (a dry-run publish without a tag is refused; with `--tag next` it passes,
public access; nothing leaves the machine). Then:

1. a Node-only app (the tarball and zod): no React, Next or UI library in its tree; `@clegra/sdk` and
   `@clegra/sdk/node` imported and run;
2. a fresh Next.js App Router app with the tarball: `npx @clegra/sdk init`, `next dev` + `npx @clegra/sdk check
   --token <the local bearer>`, `next build` + `next start` + `npx @clegra/sdk check` (the local bearer refused in
   production); a fresh app fails exactly `auth.mcp`;
3. a plain Node ESM script importing every entry, running an app with `testClient`; `tsc` with `moduleResolution`
   `bundler` and `node16` (the package's own `.d.ts` with `skipLibCheck` off);
4. both packages: a fresh Next.js app with Tailwind 4 and both tarballs, init's `--ui` library list equal to the
   `@clegra/ui` tarball's web peers and `UI_RANGE` naming its version, `npx @clegra/sdk init --ui` + `npm install`,
   a page with Button, Card and the Sidebar, `next build` + `next start` (rendered, the theme and the components'
   classes in the stylesheet), `npx @clegra/sdk check`.

The folder must have no `node_modules` or `package.json` above it. It uses `--port` to `--port + 2`. `--keep` keeps
the apps' `node_modules`.

## Publishing

Decided (owner, 2026-11-17): two scoped packages in the npm organisation `clegra`, `@clegra/sdk` (this repository)
and `@clegra/ui` (its own repository), MIT, first versions `0.1.0-next.0` on the dist-tag `next`. Publish
`@clegra/ui` first: `init --ui` names it. Still open: a public home for the code (`repository`, `homepage`, `bugs`
are left out of package.json until it exists).

```sh
npm ci
npm run typecheck && npm test && npm run hygiene
npm run pack:check -- --dir "$(mktemp -d /tmp/clegra-pack.XXXX)"
npm whoami                       # a member of the npm organisation `clegra`
npm publish --dry-run --tag next # read the file list once more
npm publish --tag next           # prepack builds dist/; the published package.json goes up; postpublish restores
```

A new version: bump `version` in package.json, move the changelog's «Unreleased» to the version, tag the commit
(`v0.1.0-next.1`), then the same steps. When `@clegra/ui` moves to a version outside `UI_RANGE`, raise it (and the
library list) in `spec/src/init/ui.ts`; the pack check fails until they match the tarball in `vendor/`.
