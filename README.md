# Rain Bird (Homey) — HTTPS fork

Fork of [`com.sortedbits.rainbird`](https://github.com/TheLostHomeyAppRepositories/com.sortedbits.rainbird)
by Wim Haanstra, whose original repository is gone and whose last release (1.2.3) predates a
firmware change on the Rain Bird LNK WiFi module.

## Why this fork exists

Recent LNK firmware closes port 80 and serves the local API over HTTPS only:

```
$ nc -z <lnk-ip> 80   -> closed
$ nc -z <lnk-ip> 443  -> open
subject= CN = fw-cc20.rainbird.com, O = Rain Bird Corporation, OU = Controls Division
```

The upstream app pins `rainbird@^1.0.1`, which only ever requests `http://<ip>/stick`, so it
cannot connect to such a controller. HTTPS-first with HTTP fallback landed in `rainbird` 1.2.10
(July 2026); the library is maintained at [`homebridge-plugins/rainbird`](https://github.com/homebridge-plugins/rainbird).

## Changes against upstream 1.2.4

- `rainbird` bumped `^1.0.1` -> `^1.2.17`. Every method the app calls (`init`, `activateZone`,
  `deactivateZone`, `deactivateAllZones`, `stopIrrigation`, `isActive`, `isInUse`,
  `remainingDuration`, `zones`, `rainSetPointReached`) is unchanged in 1.2.17.
- New capability `rain_delay_days`, polled at most once every 5 minutes.
- New Flow action **Set rain delay** (0-14 days, 0 clears it).
- New Flow action **Start a program** (A/B/C/D).
- New Flow condition **Rain delay is/isn\'t active**.
- New Flow trigger **Rain delay changed**, with a `days` token.
- `tsconfig.json` excludes `**/tests/**`, so `npm run build` no longer fails on missing jest
  globals in the app build.
- `.npmrc` sets `node-linker=hoisted` so pnpm produces a real (non-symlinked) `node_modules`,
  which is what the Homey CLI packs.

Requires Node >= 22.12 on the Homey (Homey Pro Early 2023 on firmware 13.5.0 runs Node 24.19).

## Protocol

How the app talks to the controller, and where the (unofficial) documentation lives:
[`docs/PROTOCOL.md`](docs/PROTOCOL.md).

## Install

```
pnpm install
homey login
homey app install
```

Licensed GPL-3.0, same as upstream.

## Checking the module password without the Rain Bird app

The Homey pairing wizard needs the LNK's device password. To verify a candidate
without going through the mobile app (which re-runs onboarding and can wipe a
working WiFi config):

```
read -s -p "LNK wachtwoord: " RB_PASSWORD && export RB_PASSWORD && \
  node tools/test-lnk.mjs; unset RB_PASSWORD
```

Prints the controller model, firmware, serial and zone list on success.
