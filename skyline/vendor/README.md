# Vendored dependencies

Everything the app needs is committed here so it runs from a plain static host
with no build step, no CDN and no `npm install`. Licences are listed in the
project `LICENSE`.

| File | Version | Notes |
|---|---|---|
| `three.module.js` | three r160.1 | ES module build, unmodified |
| `OrbitControls.js` | three r160.1 | bare `'three'` import rewritten to `'./three.module.js'` |
| `FontLoader.js` | three r160.1 | same import rewrite (kept for reference; the app parses the typeface JSON itself) |
| `helvetiker_bold.typeface.json` | three r160.1 | nameplate lettering |
| `earcut.js` | earcut 3.0.1 | ES module source, unmodified |
| `polygon-clipping.js` | polygon-clipping 0.15.7 | **UMD build wrapped as an ES module** — see below |
| `leaflet.js`, `leaflet.css`, `images/` | Leaflet 1.9.4 | unmodified |

## Why polygon-clipping is the UMD build

The package's published `dist/polygon-clipping.esm.js` leaves `splaytree` as a
bare import specifier, which no browser can resolve without a bundler. The UMD
build has splaytree inlined, so it is wrapped in a small CommonJS shim and
re-exported as a default ES export. That keeps the whole project buildless.

To refresh it:

```sh
curl -sSL -o /tmp/pc.js https://unpkg.com/polygon-clipping@0.15.7/dist/polygon-clipping.umd.js
{ printf 'const module = { exports: {} };\nconst exports = module.exports;\n\n'
  cat /tmp/pc.js
  printf '\n\nexport default module.exports;\n'
} > polygon-clipping.js
```
