# Map data build

Builds the boundary files the [maps app](../../apps/maps/) serves from `apps/maps/data/`.

```bash
cd scripts/maps
npm install
npm run build:boundaries   # India, downloads ~400 MB once
npm run build:world        # the world, downloads ~55 MB once; run it after build:boundaries
```

Each build also renames the cache in `apps/maps/sw.js`, so browsers that cached the old files fetch the new ones.

## Sources

- **World:** [Natural Earth](https://www.naturalearthdata.com) v5.1.2 (public domain), from its India point of
  view: 245 countries and 4,558 states / provinces. Countries are keyed by lower-case ISO 3166 alpha-2 codes
  (`us`), states by ISO 3166-2 (`us:state:US-CA`).
- **India:** the [Local Government Directory](https://lgdirectory.gov.in/) (2024), via
  [Bharatlas](https://bharatlas.com) (CC0): 36 states and UTs, 784 districts, 6,471 sub-districts, keyed by
  LGD codes (`in:district:525` is Bengaluru Urban). India's outline comes from these files too, and the world
  boundaries are cut where they overlap it, so India's states sit exactly inside it.

The output is simplified and stored in `apps/maps/data/world/` (14 MB) and `apps/maps/data/india/` (32 MB).
