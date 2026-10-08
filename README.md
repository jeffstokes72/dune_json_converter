# Dune JSON converter

A browser page that converts a Dune: Awakening solido image into a base backup, and a base backup back into a solido image. The two sample files in this repository are the same base, Dame Sabine Dyvetz’s Home Base.

A solido image is the layout: building pieces and placeables, measured from the claim console. A base backup is the `dune-base-backup` file used by the Base Reconstruction Tool. It includes that layout plus a claim console. Chests come back empty, because a solido never recorded what was stored.

When converting a solido into a backup, **Fill water cisterns** writes each cistern to its in-game capacity:

- Water cistern: 5,000
- Medium water cistern: 25,000
- Large water cistern: 100,000

Windtraps, deathstills, and blood purifiers are left unchanged.

## Use the page

GitHub Pages publishes the `docs/` folder. Until that is enabled, open it locally:

```bash
python3 -m http.server -d docs 8080
```

Then open `http://localhost:8080`. Drop either JSON file. The conversion stays in the browser.

## Check the converter

```bash
node --test test/convert.test.js
```
