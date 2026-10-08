/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { test, expect, Interop } from "./interop";
import { vi } from "vitest";

test("waits for the incoming open event and native readiness", async ({ interop }) => {
  const browser = interop.browserPeer();
  const channel = Object.assign(new EventTarget(), { readyState: "open" }) as RTCDataChannel;
  let nativeReady!: (report: RTCStatsReport) => void;
  const native = new Promise<RTCStatsReport>(resolve => { nativeReady = resolve; });
  const stats = vi.spyOn(browser, "getStats").mockReturnValue(native);
  browser.dispatchEvent(Object.assign(new Event("datachannel"), { channel }));

  let opened = false;
  const waiting = interop.waitForOpen(channel).then(() => { opened = true; });
  await Promise.resolve();
  expect(opened).toBe(false);

  channel.dispatchEvent(new Event("open"));
  await Promise.resolve();
  await Promise.resolve();
  expect(opened).toBe(false);
  expect(stats).toHaveBeenCalled();
  nativeReady(new Map() as RTCStatsReport);
  await waiting;
  expect(opened).toBe(true);
  await interop.waitForOpen(channel);
  stats.mockRestore();
});

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

test("audio capture restores microphone permission after cleanup", async ({ skip }) => {
  if (!/(?:Chrome|Chromium)\//.test(navigator.userAgent)) skip("Chromium permission control");
  const { mediaSource } = await import("./media");
  const permission = await navigator.permissions.query({ name: "microphone" as PermissionName });
  expect(permission.state).toBe("prompt");
  const media = await mediaSource("audio");
  try {
    await expect.poll(() => permission.state).toBe("granted");
    expect(media.stream.getAudioTracks()[0].readyState).toBe("live");
  } finally {
    await media.close();
  }
  expect(media.stream.getAudioTracks()[0].readyState).toBe("ended");
  await expect.poll(() => permission.state).toBe("prompt");
});
