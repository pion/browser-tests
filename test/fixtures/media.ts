/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { cdp } from "vitest/browser";

export async function mediaSource(kind: "audio" | "video") {
  if (kind === "audio") {
    const chromium = /(?:Chrome|Chromium)\//.test(navigator.userAgent);
    const permission = chromium
      ? await navigator.permissions.query({ name: "microphone" as PermissionName })
      : undefined;
    const previous = permission?.state;
    const setPermission = async (setting: PermissionState) => {
      await cdp().send("Browser.setPermission", {
        permission: { name: "microphone" }, setting, origin: location.origin,
      });
    };
    if (chromium) await setPermission("granted");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (previous) await setPermission(previous);
      throw error;
    }
    return { stream, close: async () => {
      stream.getTracks().forEach(track => track.stop());
      if (previous) await setPermission(previous);
    } };
  }
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 240;
  const context = canvas.getContext("2d")!;
  let frame = 0;
  const paint = () => {
    context.fillStyle = `hsl(${frame++ * 10 % 360}, 100%, 50%)`;
    context.fillRect(0, 0, canvas.width, canvas.height);
  };
  paint();
  const stream = canvas.captureStream(15);
  const timer = setInterval(paint, 60);
  return { stream, close: async () => {
    clearInterval(timer);
    stream.getTracks().forEach(track => track.stop());
  } };
}
