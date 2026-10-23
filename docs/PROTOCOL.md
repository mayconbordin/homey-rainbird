# Rain Bird local protocol

How this app talks to a Rain Bird controller through its LNK WiFi module, and where to look
for more detail.

Rain Bird has never published a specification for this API. Everything below comes from
community projects that reverse-engineered it, so firmware updates can change it without
notice (recent LNK firmware has already dropped plain HTTP and rejects the old request padding).

## Who implements what

The protocol lives in the [`rainbird`](https://github.com/homebridge-plugins/rainbird) npm
library; the app only calls `RainBirdService` (`init`, `activateZone`, `stopIrrigation`, ...).

The one exception is `drivers/rainbird/probe.ts`, which sends a single ModelAndVersion request
by hand during pairing. `RainBirdService.init()` can't be used for that: the library retries
some requests forever (60s apart), so a wrong password or a dead host never surfaces an error.
`tools/test-lnk.mjs` does the same check from the command line.

## Transport

- `POST /stick` on the controller's IP.
- HTTPS first, with certificate validation disabled (the module serves a self-signed
  `fw-cc20.rainbird.com` certificate). The library falls back to plain HTTP on a connection or
  TLS error, for older firmware.
- `Content-Type: application/octet-stream`; the body is binary (see below).

## Message

The body is a JSON-RPC 2.0 call to `tunnelSip`, carrying one SIP command as hex:

```json
{"id":9,"jsonrpc":"2.0","method":"tunnelSip","params":{"data":"02","length":1}}
```

`data` is the command bytes, `length` their count. The (decrypted) response carries the
controller's reply the same way, in `result.data`, or a JSON-RPC `error` object.

## Encryption

`key = SHA-256(password)`, AES-256-CBC. Request and response share one layout:

```
SHA-256(plaintext JSON)  32 bytes
IV (random)              16 bytes
AES-256-CBC(JSON)        rest, zero-padded to a multiple of 16
```

Use pure zero padding; newer LNK2 firmware crashes on the legacy `\x00\x10` suffix
(see [pyrainbird#589](https://github.com/allenporter/pyrainbird/issues/589)).

A wrong password gets `HTTP 403` with body `Invalid Password`, before any decryption.

## SIP commands

The first byte is the command code, the rest are arguments. The reply's first byte is usually
the command code + `0x80`; `0x01` is ACK and `0x00` NAK (followed by the rejected command
code and an error code).

| Command | Code | Arguments | Reply |
|---|---|---|---|
| Model and version | `02` | none | `82` model (2 bytes), major, minor |
| Available zones | `03` | page (1 byte) | `83` |
| Command support | `04` | command code | `84` |
| Serial number | `05` | none | `85` |
| Firmware version | `0B` | none | `8B` |
| Get time | `10` | none | `90` |
| Get date | `12` | none | `92` |
| Set time | `11` | hour, minute, second | ACK |
| Set date | `13` | day, month × 4096 + year (2 bytes) | ACK |
| Retrieve schedule | `20` | page (2 bytes) | `A0` |
| Water budget | `30` | program | `B0` |
| Seasonal adjust factors | `32` | program | `B2` |
| Get rain delay | `36` | none | `B6` |
| Set rain delay | `37` | days (2 bytes) | ACK |
| Run program | `38` | program (0 = A) | ACK |
| Run zone | `39` | zone (2 bytes), minutes (1 byte) | ACK |
| Test zone | `3A` | zone | ACK |
| Program zone state | `3B` | page | `BB` |
| Rain sensor state | `3E` | none | `BE` |
| Current zone | `3F` | page | `BF` |
| Stop irrigation | `40` | none | ACK |
| Advance zone | `42` | page | ACK |
| Irrigation state | `48` | none | `C8` |
| Event timestamp | `4A` | event id | `CA` |
| Stack run zone | `4B` | page, zone, minutes | ACK |
| Controller state | `4C` | none | `CC` |

The library's request and response classes are in
`node_modules/rainbird/dist/RainBird/requests/` and `.../responses/`; the reply dispatch is
`RainBirdClient.getResponse()`. Exact argument layouts are in those classes or in pyrainbird.

## References

- [pyrainbird `sipcommands.yaml`](https://github.com/allenporter/pyrainbird/blob/main/pyrainbird/resources/sipcommands.yaml):
  the closest thing to a spec. About 30 commands with codes, argument and reply field
  positions, plus commented-out ones (flow monitoring, logs). Home Assistant's Rain Bird
  integration is built on it, so it is the most widely tested.
- [homebridge-plugins/rainbird](https://github.com/homebridge-plugins/rainbird): the library
  this app uses. Its `api/api_guide.md` documents the JavaScript API, not the protocol.
- [node-red-contrib-rainbird](https://flows.nodered.org/node/node-red-contrib-rainbird): another
  implementation, with its own supported-commands table.
- [homebridge-rainbird-local](https://github.com/chundla/homebridge-rainbird-local): another
  implementation.
