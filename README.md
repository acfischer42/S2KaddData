# S2KaddData

A Signal K plugin and webapp for manually entering vessel data before a sensor or
automation is available. Configure an allowlist of self paths, nicknames and
types, then edit their values from a browser. The app shows current live values,
their source and timestamp, and the last manually saved value separately.

## Features

- Numbers, text and booleans; optional numeric bounds.
- Expandable grouping by the Signal K path tree, or a flat list.
- Percentage input: enter **42** to publish the Signal K ratio **0.42**.
- Persistent manual values, restored when the plugin/server starts.
- No periodic republishing: sensors can overwrite the live value afterward.
- Changes are saved before publishing. Failed operations are reported explicitly.
- Polling updates live readings every five seconds without replacing unsaved edits.

## Install

Requires Signal K Server with Node.js 18 or newer.

This repository is not yet published on npm. For a test installation, run
`npm pack` in the checkout, copy the resulting archive to the vessel, then install
it **from the Signal K configuration directory**:

```sh
cd /data/conf/signalk
npm install /path/to/signalk-s2k-add-data-0.1.0.tgz
```

Restart Signal K, enable **Server -> Plugin Config -> S2KaddData**, add entries,
and open **Webapps -> S2KaddData**. A package upgrade does not replace plugin data.

## Example: manual fuel tank

Configure these entries (paths are relative to `vessels.self`):

| Path | Nickname | Type | Display |
| --- | --- | --- | --- |
| `tanks.fuel.0.name` | Fuel tank name | string | native |
| `tanks.fuel.0.currentLevel` | Fuel level | number | percent |

Save `Fuel` for the name and `42` for the level in the webapp. Signal K receives
`"Fuel"` and `0.42` respectively. A tank is created by publishing its paths;
there is no separate tank creation operation. Chiplog can capture published tank
levels for future passages; this does not change historical passages.

Numbers use **Signal K SI units**: volume/capacity in m3, speed in m/s,
temperature in kelvin, angles in radians. Percentage display is the only
conversion supplied. Numeric minimum/maximum configuration also uses SI units,
so `0` and `1` bound a ratio. Percentage display always restricts ratios to 0..1.
There is no automatic conversion from a path's name. Optional bounds must be
omitted, not filled with zero, when no bound is wanted.

Never configure a path already driven by a sensor unless you intend to publish
to that path. Manual values are sent with source `signalk-s2k-add-data`. Signal K
source priorities can cause a different source to remain selected; use the live
value/source shown in the app to verify the result. A successful response means
the server accepted the publishing call, not that any physical device acted.

## Persistence and lifecycle

Manual values are stored in `values.json` inside the directory returned by
Signal K's `app.getDataDirPath()` for this plugin. Back up this directory with
the rest of your Signal K configuration. Writes use a temporary file, file
fsync and rename; the file is owner-readable/writable only.

- No default readings are invented for new paths.
- Saving publishes once; startup republishes saved values for configured paths.
- External sensor readings are displayed but are **not** persisted as manual values.
- Removing a configured path stops publishing it but retains its saved record.
  Adding it back restores that last manual value.
- Changing a saved path's type or tightening bounds so the saved value becomes
  invalid fails startup explicitly. Restore the configuration, or stop the plugin,
  back up and correct the relevant record in `values.json`, then restart.
- Corrupt or unreadable saved data fails startup; it is not silently discarded.
- Disabling/removing a path does not delete values already in Signal K's live tree.
- A publishing error after a successful disk write is reported as saved-but-not-
  published. The value is available for restoration at the next startup.

## Access and API

Signal K handles authentication: state reads require **readonly** access and saves
require **readwrite** access. On older servers without `router.access`, routes
remain admin-only. Log in to Signal K before opening the webapp. Write requests
from a different browser origin are refused.

Base: `/plugins/signalk-s2k-add-data`

- `GET /state`: running status, version, configured entries, live and saved values.
- `POST /values`: exactly `{ "path": "tanks.fuel.0.currentLevel", "value": 0.42 }`.
  The API always uses SI units, including ratios, regardless of display mode.
  Only configured paths and exact JSON types are accepted. Success returns state.
  Errors return `{ "error": "..." }`; saved-but-not-published errors additionally
  return `"persisted": true` with HTTP 503.

Do not store secrets in manual values: they are visible to Signal K readers and
stored as plaintext. This is data injection, **not** a device-control PUT handler.
Take particular care with navigation, alarm and control-related paths.

## Develop and test

```sh
npm ci
npm test
npm run check
npm pack --dry-run
npm run preview
```

Preview runs on `http://127.0.0.1:18746/`, uses a mocked Signal K model and saves
only to `.preview-data/`. It does not connect to your boat or provide real Signal K
authentication. Stop with Ctrl+C. To check reboot persistence locally, save a
value, stop preview, start it again and verify current/last manual values.

Tests cover typed edits, validation, path restrictions, persistence/restart,
live-vs-saved readings, disk/publish failures, router access declarations, and
the webapp's grouping, percent conversion, polling, edits and error handling.
No live Signal K server or physical hardware is required for these tests.

## License

MIT.
