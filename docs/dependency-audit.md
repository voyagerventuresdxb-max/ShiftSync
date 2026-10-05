# Dependency and licence audit

**Date:** 2026-10-04 · **Branch:** `chore/deps-audit` · Node 24.19, npm 11.17 · one root `package.json` (client + server).

## Updates applied

Lockfile only. `package.json` ranges are unchanged; every update is a patch/minor inside the range already declared. No new packages, nothing crosses a major version.

| package | from | to | kind |
| --- | --- | --- | --- |
| express | 4.22.2 | 4.22.3 | direct |
| undici | 6.28.0 | 6.29.0 | direct |
| undici (nested copy) | 7.29.0 | 7.30.0 | transitive |
| body-parser | 1.20.6 | 1.20.8 | transitive |
| qs | 6.15.3 | 6.16.0 | transitive |
| ip-address | 10.5.0 | 10.7.3 | transitive |
| hono | 4.13.2 | 4.13.13 | transitive |
| brace-expansion | 1.1.18 / 5.0.9 | 1.1.21 / 5.0.12 | transitive |
| js-yaml | 4.3.1 | 4.3.2 | transitive |
| @grpc/grpc-js | 1.14.4 | 1.14.5 | transitive |
| axios | 1.19.0 | 1.20.0 | transitive |

Tried and reverted: a broader in-range refresh of one dev-tool dependency tree. It would have moved several transitive packages across a major version and added new packages, for a small reduction in the count below.

Not done: general in-range refreshes that no advisory asks for (`npm outdated` lists them). Out of scope for this pass.

## Advisory counts (`npm audit`)

| severity | flagged packages before | after | unique advisories before | after |
| --- | --- | --- | --- | --- |
| critical | 1 | 1 | 1 | 1 |
| high | 25 | 20 | 38 | 22 |
| moderate | 34 | 29 | 36 | 13 |
| low | 0 | 0 | 5 | 0 |
| **total** | **60** | **50** | **80** | **36** |

**36 advisories remain, and no patch/minor update clears any of them.** Each one needs a major upgrade, a change to a declared range, or a release that doesn't exist upstream yet. That is an owner decision; the details are in the owner's report.

## xlsx (not visible to `npm audit`)

`xlsx` is installed from the SheetJS CDN tarball (`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, Apache-2.0). The lockfile pins its URL and sha512. `npm audit` and Dependabot can't see URL dependencies, so it isn't in the counts above. It was left unchanged. Check SheetJS releases by hand, and re-run the parser timezone matrix gate on any bump (`docs/parser-timezone-safety.md`).

## Checks after the updates

All results match a run before the updates:

- `tsc --noEmit` (root and `server`): clean.
- `npm run lint`: 0 errors, 18 warnings.
- `npm test`: 94/94.
- `npm run build`: ok.
- `npm run test:server`: 618 pass, 3 skipped, 0 fail (621 total).
- `npm run eval:roster`: same scores as before (name/day/start/end 94%, role 100%, leave 94%, flagged 100%, escalation 3/18 with 18/18 agreeing).
- `parserTimezoneMatrix.test.ts`: 5/5.

## Licences

### Direct dependencies

| package | licence | | package (dev) | licence |
| --- | --- | --- | --- | --- |
| @capacitor/android | MIT | | @capacitor/cli | MIT |
| @capacitor/app | MIT | | @eslint/js | MIT |
| @capacitor/core | MIT | | @playwright/test | Apache-2.0 |
| @dnd-kit/dom | MIT | | @types/cors | MIT |
| @dnd-kit/react | MIT | | @types/express | MIT |
| @google/genai | Apache-2.0 | | @types/multer | MIT |
| @prisma/client | Apache-2.0 | | @types/node | MIT |
| @tailwindcss/vite | MIT | | @types/qrcode | MIT |
| clsx | MIT | | @types/react | MIT |
| cors | MIT | | @types/react-dom | MIT |
| dayjs | MIT | | @types/web-push | MIT |
| dotenv | BSD-2-Clause | | @vitejs/plugin-react | MIT |
| express | MIT | | concurrently | MIT |
| express-rate-limit | MIT | | cross-env | MIT |
| libphonenumber-js | MIT | | eslint | MIT |
| lucide-react | ISC | | eslint-plugin-react-hooks | MIT |
| motion | MIT | | eslint-plugin-react-refresh | MIT |
| multer | MIT | | globals | MIT |
| pdf-parse | Apache-2.0 | | kill-port | MIT |
| pdfjs-dist | Apache-2.0 | | pdf-lib | MIT |
| prisma | Apache-2.0 | | ruflo | MIT (declared, no licence file) |
| qrcode | MIT | | typescript | Apache-2.0 |
| react | MIT | | typescript-eslint | MIT |
| react-dom | MIT | | vite | MIT |
| react-router-dom | MIT | | | |
| tailwind-merge | MIT | | | |
| tailwindcss | MIT | | | |
| tsx | MIT | | | |
| tw-animate-css | MIT | | | |
| undici | MIT | | | |
| **web-push** | **MPL-2.0** | | | |
| xlsx | Apache-2.0 | | | |

The client bundle ships only MIT and ISC code: React, React Router, dnd-kit, motion, lucide-react, clsx, tailwind-merge, dayjs and Capacitor.

### Flagged

Nothing in the installed tree or the lockfile is GPL, AGPL, SSPL, EUPL, CC-BY-NC or UNLICENSED.

- **web-push (MPL-2.0)**: a direct runtime dependency, used by the API only. MPL-2.0 is file-level copyleft. Using it unmodified only means keeping its licence notice. If its own files are ever modified and distributed, those files must be published under MPL-2.0. *Recommendation:* keep it, and don't patch its files in place (vendoring or patch-package) without planning to publish the change.
- **lightningcss (MPL-2.0)**: pulled in by `vite` and `@tailwindcss/vite`. It runs at build time only and isn't in the shipped bundle. *No action.*
- **ruflo (dev tooling)**: it declares MIT but ships no licence file. Several of its `@claude-flow/*` sub-packages declare no licence at all. Its tree also contains MPL-2.0 packages (`@ubjs/*`) and LGPL-3.0-or-later binaries (the prebuilt libvips bundled with `sharp`). None of this is imported by the app or the API, or shipped in the web bundle or Android build. A server build that installs devDependencies would carry it in `node_modules` unused, and running code on our own server isn't distribution. *Recommendation:* keep ruflo out of anything shipped. If a clean bill matters (store review, due diligence), drop it from `package.json` and install it per developer instead. `scripts/generate-icons.mjs` currently borrows `sharp` from that tree and would need its own copy.
- Attribution-style licences (CC-BY-4.0 `caniuse-lite`, Python-2.0 `argparse`, BlueOak-1.0.0 `glob`/`tar`/…) are all build or dev tooling. *No action.*

*Store builds:* MIT, ISC and Apache-2.0 all require their notices to travel with distributed copies. Generate a third-party notices file or screen for the Android/iOS builds.

*Not covered:* native Android (Gradle) dependencies under `android/`. They aren't npm packages, so this scan doesn't see them.
