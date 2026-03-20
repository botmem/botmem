# Locations / OwnTracks Connector

The OwnTracks connector imports GPS location history from a self-hosted [OwnTracks](https://owntracks.org/) recorder instance.

**Auth type:** API Key (HTTP basic auth)
**Trust score:** 0.85
**Source types:** `location`

## What It Syncs

- **Location points** -- GPS coordinates (latitude, longitude) with timestamps
- **Accuracy** -- GPS accuracy in meters
- **Battery level** -- device battery percentage at the time of the report
- **Velocity** -- speed in km/h (when available)
- **Altitude** -- elevation in meters (when available)

## Setup

### 1. OwnTracks Recorder

You need a running [OwnTracks Recorder](https://github.com/owntracks/recorder) instance. The recorder collects location data from the OwnTracks mobile app and provides an HTTP API.

### 2. Configure in Botmem

Navigate to the Connectors page and click **Add** on the Locations / OwnTracks connector. Enter:

| Field              | Value                                                               |
| ------------------ | ------------------------------------------------------------------- |
| Base URL           | Your OwnTracks recorder URL (e.g., `https://owntracks.example.com`) |
| Username           | HTTP auth username                                                  |
| Device             | Device identifier (e.g., `iphone`)                                  |
| HTTP Auth Username | Basic auth username for the recorder API                            |
| HTTP Auth Password | Basic auth password for the recorder API                            |

::: tip
The Base URL should not include the `/pub` suffix. The connector builds the correct API paths automatically.
:::

## How Sync Works

1. Queries the OwnTracks recorder API for location points
2. Fetches data for the configured user and device
3. For each location point, emits a `ConnectorDataEvent` with:
   - `sourceType: 'location'`
   - `text`: human-readable description (e.g., "Location: 37.7749, -122.4194")
   - `metadata.lat`: latitude
   - `metadata.lon`: longitude
   - `metadata.acc`: accuracy in meters
   - `metadata.batt`: battery percentage
   - `metadata.vel`: velocity
   - `metadata.alt`: altitude
4. Uses timestamps as cursors for incremental sync

## Location Memories

Each location point becomes a memory in the store. During the embed phase, GPS coordinates are resolved offline to city/state/country using the GeoNames cities500 dataset (~200k cities). No external API calls are made — all geocoding happens locally via PostgreSQL's `earthdistance` extension.

Location memories are useful for:

- Answering "where was I on Tuesday?"
- Cross-referencing with photos taken at the same time
- Building timelines that include physical movement

## Limitations

- **OwnTracks Recorder required** -- the connector reads from the recorder's HTTP API, not directly from the mobile app
- **City-level geocoding only** -- location names are resolved to city/state/country level (no street addresses). Uses the GeoNames cities500 dataset with ~200k cities worldwide
- **No regions/waypoints** -- OwnTracks region enter/exit events are not currently imported

## Troubleshooting

### "401 Unauthorized" error

Check your HTTP basic auth credentials. The OwnTracks recorder requires authentication for API access.

### No location data returned

Make sure the OwnTracks mobile app is configured to report to your recorder, and that the username and device match what you entered in Botmem.

### Gaps in location history

OwnTracks reports locations based on significant movement. If the device was stationary, there may be gaps. This is normal behavior.
