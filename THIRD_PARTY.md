# Third-party notices

## Herald OS

Some intelio home, missions and command-bar code is adapted from
[Herald OS](https://github.com/iamlukethedev/Herald-OS) v0.1.0-alpha.2 by
Luke The Dev. intelio does not depend on Herald OS or vendor its repository; the
ideas were reimplemented in intelio's own style. Files with closely adapted code
carry a header naming the Herald OS source file:

| intelio file | Adapted from (Herald OS) |
| --- | --- |
| `desktop/src/intelio/commands.cjs` | `apps/desktop/src/store/os-commands.ts` (command shape, typed args, tiers, results that never throw) |
| `desktop/src/intelio/missions.cjs` | `apps/desktop/src/store/missions.ts`, `apps/desktop/src/lib/continuity.ts` (mission status from the transcript, the plan-first mission prompt) |
| `desktop/src/intelio/home-feed.cjs` | `apps/desktop/src/features/overview/*` (greeting, recent work, "pick up where you left off") |
| `desktop/src/home-ui.js`, `desktop/src/home.css` | `apps/desktop/src/features/overview/*`, `apps/desktop/src/shell/CommandBar.tsx`, `apps/desktop/src/components/ui/glass.tsx`, `DESIGN.md` (layout, section headers, cards, empty states) |
| `mobile/pwa/public/home-tab.js`, `mobile/pwa/public/home-tab.css` | `apps/desktop/src/features/overview/*` (phone layout of the same home) |

```
MIT License

Copyright (c) 2026 Luke The Dev (@iamlukethedev)

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
