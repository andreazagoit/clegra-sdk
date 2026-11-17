# Releasing `clegra`

The package is this repository's root. Versions before 1.0 are prereleases on the dist-tag `next`
(`0.1.0-next.0` first). This page is what the tarball holds, how it is checked, and the publish steps.

## What ships

- In the repository, `package.json` exports TypeScript source (`./src/index.ts`, …). The examples (npm workspaces of
  this repository, depending on `clegra` as `file:../..`) and the tests import it with no build step.
- `npm pack` (its `prepack`, `scripts/prepack.mjs`) builds `dist/` with `tsc` (`scripts/build.mjs`: ESM JavaScript,
  `.d.ts`, source maps with the sources inlined; relative imports get their `.js`; the JSON Schema and `kinds.json`
  copied next to the code that reads them; the CLI with a `node` shebang). Then it swaps in the published package.json:
  exports `{ types, default }` in `dist/`, `bin` `dist/spec/src/cli.js`, no devDependencies, workspaces or overrides,
  and of the scripts only `postpublish`. `postpack` (or, during a real publish, `postpublish`) puts the repository's
  package.json back: npm re-reads package.json after packing and uploads that as the version's metadata, so it must
  still be the published one at that moment. `dist/` is git-ignored.
- `clegra/ui` (`scripts/ui.mjs`): `ui/` compiled to `dist/ui` (ESM + `.d.ts`, `"use client"` kept, no source maps,
  comments without repository paths), its exports with their `react-native` / `ios` conditions mapped to `dist`; the
  stylesheets with the brand's palette inside (`dist/ui/brand/`), `metro.cjs` and the generated `prebuilt.css`. Left
  out: the components reserved for Clegra's shell (`RESERVED_COMPONENTS`, their paths closed with `null`) and the
  native plumbing only they use, the repository-only entries (`clegra/ui/drawn/*`, the other `clegra/ui/native/*`
  files, shipped as files), the tests. The build refuses any bare import in `dist/ui` that is not a declared (peer)
  dependency.
- Entries: `clegra`, `clegra/next`, `clegra/node`, `clegra/testing`, `clegra/spec`,
  `clegra/clegra.schema.json`, `clegra/kinds.json`, `clegra/package.json`, `clegra/ui/...` ([ui.md](ui.md)); the
  CLI `clegra` (`check`, `init [--ui]`).
- Dependencies: `@modelcontextprotocol/server`, `ajv`, `jose`. Peers: `zod` 4, `next` 15+ (optional: only
  `clegra/next` imports it, as types), and every library `clegra/ui` imports (React 19, Base UI, lucide, recharts, …,
  React Native's; Tailwind 4): all optional, never bundled, so a Node-only app installs none of them. To decide before publishing: `zod` `^4.2.0`, the MCP SDK's own range
  (it depends on zod ^4.2.0; an app on zod 4.0/4.1 gets a second copy for the SDK).
- Files: `dist`, `docs/spec.md` and `docs/quickstart.md` (read from the installed package, e.g. by Clegra's site),
  `README.md`, `LICENSE` (MIT, «Copyright (c) 2026 Clegra»), `NOTICE.md` (the trademark and the third-party work
  `clegra/ui` builds on), `CHANGELOG.md`, `package.json`. Not: `examples/`, the other docs, `scripts/`, tests.

## The guard

- A prerelease (`0.1.0-next.0`) is published with a dist-tag only, so it never becomes `latest`. npm refuses
  `npm publish` of a prerelease without `--tag` («You must specify a tag using --tag when publishing a prerelease
  version», checked with npm 11.6), unless `--force`; `prepack` refuses it too, before anything is built, with
  `--force` or not.
- `npm publish --dry-run --tag next` runs everything (build, swap, restore) and uploads nothing.
- If a real publish fails after packing (network, authentication, a version that exists), package.json may still be
  the published one: `node scripts/postpack.mjs` puts the repository's back (`git status` shows it). `prepack`
  refuses to start while `.package.repo.json` is there.

## The pack check

```sh
npm run pack:check -- --dir /some/empty/folder/outside/the/repo --port 3946
```

Slow (three `npm install`s, `next dev`, `next build`; a few minutes on a warm npm cache), so not in `npm test`. It
packs the tarball and checks its files and package.json (every export target, patterns included, in the tarball;
`types` before `default` in every condition object; `clegra/ui`'s stylesheets, components, `"use client"`, reserved
components closed and absent, no repository-only entry, every UI library an optional peer), that every relative
import in `dist` resolves inside the tarball, the hygiene check (`scripts/hygiene.mjs`: no private or customer
name, private repository path or secret), and the guard (a dry-run publish without a tag is refused; with `--tag next`
it passes; nothing leaves the machine). Then a Node-only app (the tarball and zod): no React, React DOM, React Native or UI library in its tree,
`clegra` and `clegra/node` imported and run. Then a fresh Next.js App Router app with Tailwind 4 (the repository's
Next, React, TypeScript and Tailwind versions) with the tarball installed: `npx clegra init --ui` and `npm install`,
a page drawn with `clegra/ui`'s Button and Card, `next dev` + `npx clegra check --token <the local bearer>`,
`next build` + `next start` (the page renders the components, its stylesheet has the theme and their classes) +
`npx clegra check` (the local bearer refused in production), a plain Node ESM script importing every entry and
running an app with `testClient`, and `tsc` with `moduleResolution` `bundler` and `node16` (the package's own
`.d.ts` with `skipLibCheck` off; `clegra/ui`'s entries in a `.tsx`). The folder must have no `node_modules` or `package.json` above it.
It uses `--port` and `--port + 1`. `--keep` keeps the app's `node_modules`.

## Publishing

Decided (owner, 2026-11-16/17): the unscoped name `clegra` (free on 2026-11-17: `npm view clegra` answers 404), MIT,
first version `0.1.0-next.0` on the dist-tag `next`. Still open: a public home for the code (`repository`,
`homepage`, `bugs` are left out of package.json until it exists).

```sh
npm ci
npm run typecheck && npm test && npm run hygiene
npm run pack:check -- --dir "$(mktemp -d /tmp/clegra-pack.XXXX)"
npm whoami                       # the account that will own the package
npm publish --dry-run --tag next # read the file list once more
npm publish --tag next           # prepack builds dist/; the published package.json goes up; postpublish restores
```

`/tmp` has no `package.json` above it (the pack check needs that). A new version: bump `version` in package.json,
move the changelog's «Unreleased» to the version, tag the commit (`v0.1.0-next.1`), then the same steps. The first
non-prerelease (`0.1.0` or `1.0.0`) is published without `--tag` (it becomes `latest`).
