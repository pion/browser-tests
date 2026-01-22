/**
* SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
* SPDX-License-Identifier: MIT
*/

import { defineConfig } from "vitest/config";
import { webdriverio } from "@vitest/browser-webdriverio";

const browserName = process.env.TEST_BROWSER || "chrome";
const useLocalDrivers = Boolean(process.env.CHROME_BIN);

const capabilities = {
  ...(browserName !== "safari" ? { webSocketUrl: true } : {}),
  ...(useLocalDrivers ? { "wdio:skipAutomationSetup": true } : {}),
  "goog:chromeOptions": {
    ...(useLocalDrivers ? { binary: process.env.CHROME_BIN } : {}),
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--no-sandbox",
    ],
  },
  "moz:firefoxOptions": {
    prefs: {
      "media.autoplay.default": 0,
      "media.autoplay.enabled.user-gestures-needed": false,
      "media.autoplay.block-webaudio": false,
      "media.autoplay.ask-permission": false,
      "media.navigator.permission.disabled": true,
      "media.navigator.streams.fake": true,
    },
  },
  "ms:edgeOptions": {
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  },
  "safari:autoplay": true,
};

export default defineConfig({
  test: {
    testTimeout: 60_000,
    include: ["test/**/*.test.ts"],
    browser: {
      enabled: true,
      provider: webdriverio({ capabilities }),
      headless: browserName !== "safari" && process.env.TEST_HEADLESS !== "false",
      connectTimeout: 90_000,
      instances: [
        {
          name: browserName,
          browser: browserName.toLowerCase() as "chrome" | "firefox" | "edge" | "safari",
        },
      ],
    },
  },
});
