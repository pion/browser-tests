/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { test, expect, Interop } from "./interop";

test("cleans up all peers and pending listeners after a setup failure", async () => {
  const scope = new Interop();
  const browser = scope.browserPeer();
  const pion = await scope.pionPeer();
  const pending = scope.event(browser, "datachannel");
  try {
    await expect(pion.setRemoteDescription({ type: "offer", sdp: "invalid" })).rejects.toThrow("set-remote-description");
  } finally {
    await scope.close();
  }
  await expect(pending).rejects.toThrow("Cancelled");
  expect(browser.signalingState).toBe("closed");
  await expect(pion.snapshot()).rejects.toThrow("404");
  await scope.close();
});
