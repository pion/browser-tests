# Pion Browser Tests

Browser interoperability tests for [pion/webrtc](https://github.com/pion/webrtc).
The suite connects real browser `RTCPeerConnection` instances to Pion peers and
checks signaling, data channels, media transport, and connection restarts.
Tests run in Chrome, Firefox, Edge, and Safari using Vitest and WebdriverIO.

## How it works

The [runner](scripts/run-browser-tests.ts) builds and starts a Go test server,
waits for it to become ready, and launches the selected browser. Tests control
Pion peers through the server's HTTP API: creating offers and answers,
exchanging ICE candidates, opening channels, and reading connection stats.

## Run locally

Install Node.js 24 or later, Go with the toolchain specified in [go.mod](go.mod),
and the browser you want to test. Browser automation also needs a matching
WebDriver. You can provide explicit paths when automatic discovery is unsuitable:

| Browser | Browser executable | WebDriver executable |
| --- | --- | --- |
| Chrome / Chromium | `CHROME_BIN` | `CHROMEDRIVER_PATH` |
| Firefox | `FIREFOX_BIN` | `GECKODRIVER_PATH` |
| Edge | `EDGE_BIN` | `EDGEDRIVER_PATH` |
| Safari | System Safari on macOS | System `safaridriver` |

Safari requires Remote Automation to be enabled. The CI action enables it with
`sudo safaridriver --enable`.

```sh
npm ci
npm run test:chrome
```

Use `test:firefox`, `test:edge`, or `test:safari` to select another browser.
`npm test` defaults to Chrome. Browsers run headlessly by default except Safari;
set `TEST_HEADLESS=false` to show another browser's window.

With Nix, `nix develop` provides Go and Node.js. On Linux it also provides
Chromium, Firefox, and their WebDrivers.

Arguments after `--` are forwarded to Vitest, apart from `--webrtc`:

```sh
npm run test:chrome -- test/media/srtp.test.ts
npm run test:firefox -- test/datachannel/echo.test.ts -t 'echoes binary'
```

### Select the Pion version

By default, the server uses the dependency versions in this repository's
`go.mod`. Use `--webrtc` to test a local checkout, including uncommitted changes,
or a branch, tag, or commit from `pion/webrtc`:

```sh
npm run test:chrome -- --webrtc /path/to/webrtc
npm run test:firefox -- --webrtc main
```

Both WebRTC v4 and v5 checkouts are supported. The runner uses a temporary Go
workspace.

`PION_WEBRTC_SOURCE` is the environment-variable equivalent of `--webrtc`.
Set `PION_WEBRTC_REPOSITORY` to fetch remote revisions from a different Git
repository, such as a fork.

## Development

Browser tests live in [test/](test/). Shared fixtures in
[test/fixtures/](test/fixtures/) manage browser and Pion peers, signaling,
media sources, and feature detection. The Go peer-control API and echo behaviors
live in [internal/testserver/](internal/testserver/).

```sh
npm run lint
npm run typecheck
npm run test:runner
go test ./...
```

`test:runner` checks process lifecycle and WebRTC source selection without
launching a browser. Run the relevant browser tests separately when changing
interop behavior. Test output includes available DTLS and SRTP transport details;
failed tests also log peer descriptions, state history, and stats.

## Community and license

Join the [Pion Discord](https://discord.gg/PngbdqpFbt) for discussion and see the
[contributing guide](https://github.com/pion/webrtc/wiki/Contributing) to get
involved.

MIT licensed. See [LICENSE](LICENSE).
