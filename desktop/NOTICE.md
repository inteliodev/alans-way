# Desktop distribution licensing

Copyright (c) 2026 Hermes Workspace contributors.

The desktop application is distributed under **GPL-3.0-or-later**; see
[LICENSE](LICENSE). Earlier original desktop code was released under MIT, whose
notice is retained in [LICENSE-MIT](LICENSE-MIT). The separate Python Hermes
Companion add-on remains MIT under the repository's root LICENSE.

The desktop includes:

- `electron-chrome-extensions` 4.9.0, copyright Samuel Maddock, used under its
  GPL license option. Its GPL text and copyright/license declarations are
  included in `node_modules/electron-chrome-extensions/` in packaged builds.
- `electron-chrome-web-store` 0.13.0, copyright Samuel Maddock, MIT.
- The protected-path list and containment check in `src/intelio/node/policy.cjs`
  are adapted from Herald OS (`plugins/herald-os-bridge/bridge/permissions.py`),
  MIT License, Copyright (c) 2026 Luke The Dev (@iamlukethedev).
- Electron, MIT, with Chromium and other third-party notices in the application
  bundle; noVNC, MPL-2.0; the MCP TypeScript SDK, MIT; and other dependencies with
  their notices retained alongside their code.

Build from this directory with `npm ci`, `npm run build:preload`, and
`npm run package:mac`. Source, build scripts, tests, and the dependency lockfile
are part of this repository. Any distributed binary release must provide its
matching complete source and preserve these license notices. Installed Web Store
extensions are downloaded separately to private app data; their code is not
part of this repository or bundled release and retains its authors' terms.
