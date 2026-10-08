# Third-party code shipped to the browser

Packages that are not just build tooling, with what was checked before they were added.

## thinking-orbs 0.3.2

The dotted orb on the voice sheet (`src/components/shiftsync/VoiceOrb.tsx`) draws the dot
geometry from this package's `thinking-orbs/engine` export, in the app's own gold, with the app's
own render loop. Only the geometry and two density helpers are used; the package's React component
and its pointer "gravity" feature are not.

| | |
|---|---|
| Version | `0.3.2`, pinned exactly in `package.json` (no range) |
| Tarball | `https://registry.npmjs.org/thinking-orbs/-/thinking-orbs-0.3.2.tgz` |
| Integrity | `sha512-QZFeBaPEzqhjiZoXy961EvDgaXk2WgXacF3Rbz+Sj5IfzDzBvTC86vdREUHniBffYibJFKSwbfllxLUdI/Xv6g==` |
| Licence | MIT (text below) |
| Author | Jakub Antalik |
| Source | https://github.com/Jakubantalik/Libraries.dev (`packages/thinking-orbs`) |
| Runtime dependencies | none (peer: `react >= 18`) |
| Loaded | only with the voice sheet (a lazy chunk), never on screens that don't open voice |
| Notice shipped | `public/third-party-licenses.txt`, served at `/third-party-licenses.txt` (the minifier drops source comments) |

Checked before adding (2026-10-08):

1. Registry metadata: the repository is the author's own (not a fork), published by its single
   maintainer; the 0.3.2 release matches an upstream commit made two minutes before publishing.
2. Tarball: 26 files (the built `dist`, licence, readme, package manifest); no install or
   postinstall scripts; no network, storage or cookie access; readable, unminified code; the
   installed files are byte-identical to the inspected tarball, and the registry integrity matches.
   Installed with `--ignore-scripts`.
3. Licence text and copyright holder present in the package; React 19 satisfies the peer range;
   a tint option exists; the `engine` export exposes the dot geometry; the stock component has a
   reduced-motion still frame and pauses when hidden (our renderer does the same itself).

To update: repeat the checks above against the new version, then change the exact version and
the integrity here.

### Licence

```
MIT License

Copyright (c) 2026 Jakub Antalik

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
