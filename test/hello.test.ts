/**
* SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
* SPDX-License-Identifier: MIT
*/

import { describe, it, expect } from "vitest";
import {
  exchangeOffer,
  waitForDataChannelMessage,
  waitForDataChannelOpen,
  waitForIceGatheringComplete,
} from "./helpers/pion";

describe("Browser Hello World", () => {
  it("should execute JavaScript in the browser", () => {
    expect("Hello from browser!").toBe("Hello from browser!");
  });

  it("should access browser APIs", () => {
    expect(typeof navigator.userAgent).toBe("string");
    expect(navigator.userAgent.length).toBeGreaterThan(0);
  });

  it("should verify RTCPeerConnection exists", () => {
    expect(typeof RTCPeerConnection).toBe("function");
  });

  it("should create an RTCPeerConnection", async () => {
    const pc = new RTCPeerConnection();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    expect(pc.localDescription?.type).toBe("offer");
    pc.close();
  });

  it("should exchange a Pion hello-world data channel", async () => {
    const pc = new RTCPeerConnection();
    const channel = pc.createDataChannel("hello");

    try {
      await pc.setLocalDescription(await pc.createOffer());
      await waitForIceGatheringComplete(pc);

      const localDescription = pc.localDescription;
      if (!localDescription) {
        throw new Error("Missing local description");
      }
      const answer = await exchangeOffer(localDescription);
      await pc.setRemoteDescription(answer);
      await waitForDataChannelOpen(channel);

      channel.send("hello pion");
      const response = await waitForDataChannelMessage(channel);
      expect(response).toBe("hello pion");
    } finally {
      channel.close();
      pc.close();
    }
  });
});
