/**
* SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
* SPDX-License-Identifier: MIT
*/

import { defineConfig } from "vitest/config";
import {
  webdriverio,
  type WebdriverProviderOptions,
} from "@vitest/browser-webdriverio";

const browserName = (process.env.TEST_BROWSER || "chrome").toLowerCase();
if (
  browserName !== "chrome" && browserName !== "firefox" &&
  browserName !== "edge" && browserName !== "safari"
) {
  throw new Error(
    `Unsupported TEST_BROWSER "${browserName}". Use chrome, firefox, edge, or safari.`,
  );
}

const chromiumArgs = [
  "--autoplay-policy=no-user-gesture-required",
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
];

const capabilitiesByBrowser = {
  chrome: {
    webSocketUrl: true,
    "goog:chromeOptions": {
      binary: process.env.CHROME_BIN,
      args: [...chromiumArgs, "--no-sandbox"],
    },
    "wdio:chromedriverOptions": {
      binary: process.env.CHROMEDRIVER_PATH,
    },
  },
  firefox: {
    webSocketUrl: true,
    "moz:firefoxOptions": {
      binary: process.env.FIREFOX_BIN,
      prefs: {
        "media.autoplay.default": 0,
        "media.autoplay.enabled.user-gestures-needed": false,
        "media.autoplay.block-webaudio": false,
        "media.autoplay.ask-permission": false,
        "media.navigator.permission.disabled": true,
        "media.navigator.streams.fake": true,
      },
    },
    "wdio:geckodriverOptions": {
      binary: process.env.GECKODRIVER_PATH,
    },
  },
  edge: {
    webSocketUrl: true,
    "ms:edgeOptions": {
      binary: process.env.EDGE_BIN,
      args: [...chromiumArgs],
    },
    "wdio:edgedriverOptions": {
      binary: process.env.EDGEDRIVER_PATH,
    },
  },
  safari: {
    "wdio:enforceWebDriverClassic": true,
  },
} satisfies Record<
  typeof browserName,
  NonNullable<WebdriverProviderOptions["capabilities"]>
>;

export default defineConfig({
  test: {
    testTimeout: 60_000,
    include: ["test/**/*.test.ts"],
    browser: {
      enabled: true,
      provider: webdriverio({ capabilities: capabilitiesByBrowser[browserName] }),
      headless: browserName !== "safari" && process.env.TEST_HEADLESS !== "false",
      connectTimeout: 90_000,
      instances: [
        {
          name: browserName,
          browser: browserName,
        },
      ],
    },
  },
});
