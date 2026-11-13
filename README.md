# S2KaddData

A Signal K plugin and webapp for manually entering vessel data before a sensor or
automation is available. Configure an allowlist of self paths, nicknames, optional
groups and types, then edit their values from a browser. The app shows current live values,
their source and timestamp, and the last manually saved value separately.

## Features

- Numbers, text and booleans; optional numeric bounds.
- Compact one-line editing with expandable configured groups, or a flat list.
- Select a parameter name to see its path, source, timestamp and last manual value.
- Percentage input: enter **42** to publish the Signal K ratio **0.42**.
- Persistent manual values, restored when the plugin/server starts.
- No periodic republishing: sensors can overwrite the live value afterward.
- Changes are saved before publishing. Failed operations are reported explicitly.
- Polling updates live readings every five seconds without replacing unsaved edits.

## Install

Requires Signal K Server with Node.js 18 or newer.

Install **S2KaddData** through the Signal K Appstore, or install it from npm
in the Signal K configuration directory:

```sh
cd /data/conf/signalk
npm install signalk-s2k-add-data
```

Restart Signal K, enable **Server -> Plugin Config -> S2KaddData**, add entries,
and open **Webapps -> S2KaddData**. A package upgrade does not replace plugin data.

## Example: manual fuel tank

Configure these entries (paths are relative to `vessels.self`):

| Path | Nickname | Group | Type | Display |
| --- | --- | --- | --- | --- |
| `tanks.fuel.0.name` | Fuel tank name | Tanks | string | native |
| `tanks.fuel.0.currentLevel` | Fuel level | Tanks | number | percent |

Group names are optional, case-sensitive, and trimmed. Entries with no group
appear together under **Ungrouped**; a group explicitly named `Ungrouped` joins
that same section. Groups and their entries appear in configuration order.
Existing configurations without group names continue to work.

Save `Fuel` for the name and `42` for the level in the webapp. Signal K receives
`"Fuel"` and `0.42` respectively. A tank is created by publishing its paths;
there is no separate tank creation operation. Chiplog can capture published tank
levels for future passages; this does not change historical passages.

`currentLevel` is a fraction of tank capacity, not a sounding or fluid depth.
For example, 42 cm cannot be entered as 42% without converting the measurement
using the tank's geometry or calibration. A custom path can store a physical
measurement in metres, but Chiplog will not automatically treat it as a tank level.

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

## Releasing

GitHub Actions runs tests on Node 18, 22 and 24. A pushed `v` tag matching
`package.json` runs those tests before publishing to npm using trusted publishing
and provenance. Stable versions receive the npm `latest` tag; prereleases
receive `next`. A manually dispatched publish workflow runs tests only and
does not publish. Create GitHub releases separately when appropriate.

The npm package's trusted publisher must be configured for this repository and
the `publish.yml` workflow, with permission for `npm publish`. npm requires
the first successful publish within two days of adding the trusted publisher,
otherwise the configuration expires. Confirm the workflow and public registry
before restricting other publishing methods.

## License

MIT.
