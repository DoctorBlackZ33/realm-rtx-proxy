# Third-party notices

Realm RTX Proxy includes the following direct npm dependencies. Versions and declared license identifiers below are taken from this repository's `package-lock.json` and the installed packages' `package.json` metadata; they are not licenses for Realm RTX Proxy itself.

| Package | Version / source | Declared license |
| --- | --- | --- |
| `bedrock-protocol` | 3.61.0 | MIT |
| `jsonwebtoken` | 9.0.3 | MIT |
| `nethernet` | 1.1.2 | MIT |
| `prismarine-xbox-services` | 0.1.0, commit `052a9676f514c5470a723651b1dbb1adcf238944` | MIT |
| `raknet-native` | 1.2.3 | ISC |

The portable releases also include the upstream Node.js v24.22.2 x64 runtime and its upstream `LICENSE` file. Node.js's license file includes the Node.js license text and notices/licenses for externally maintained libraries bundled with Node. See [Node.js v24.22.2 LICENSE](https://github.com/nodejs/node/blob/v24.22.2/LICENSE) and the [Node.js v24.22.2 release archive](https://nodejs.org/download/release/v24.22.2/).

The locked transitive npm dependencies are included under `node_modules/`. Their package-specific license and notice files shipped with those packages are retained there; consult each package's own `LICENSE`, `LICENCE`, `NOTICE`, and `package.json` for its applicable terms. `package-lock.json` records the resolved dependency tree. This notice does not assign one blanket license to transitive dependencies or replace their included notices.
