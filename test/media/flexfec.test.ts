/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { test, expect } from "../fixtures/interop";
import { mediaSource } from "../fixtures/media";

test("FlexFEC with multi-frame protection groups repairs loss without retransmission", async ({ interop, skip }) => {
  await interop.features.require({ skip }, "pion.flexfecMultiFrame", "browser.flexfecReceive");
  const media = await mediaSource("video");
  try {
    // flexfec-echo drops every 10th echoed video packet, does not negotiate NACK, and groups
    // up to 3 frames per FEC protection group.
    const pion = await interop.pionPeer({ behavior: "flexfec-echo" });
    const browser = interop.browserPeer();
    const codecs = (...mimeTypes: string[]) => RTCRtpReceiver.getCapabilities("video")!.codecs
      .filter(codec => mimeTypes.includes(codec.mimeType.toLowerCase()));
    // Browsers only receive FlexFEC, so they offer it only in a receive-only section.
    browser.addTransceiver(media.stream.getVideoTracks()[0], { direction: "sendonly", streams: [media.stream] })
      .setCodecPreferences(codecs("video/vp8"));
    const echo = browser.addTransceiver("video", { direction: "recvonly" });
    echo.setCodecPreferences(codecs("video/vp8", "video/flexfec-03"));
    await interop.negotiate(browser, pion);
    expect(browser.remoteDescription?.sdp, "FlexFEC negotiated").toMatch(/^a=ssrc-group:FEC-FR /m);

    const inbound = async () => {
      const stats = await browser.getStats(echo.receiver.track);
      return Array.from(stats.values()).find(stat => stat.type === "inbound-rtp") as
        (RTCInboundRtpStreamStats & {
          fecPacketsReceived?: number; pliCount?: number; retransmittedPacketsReceived?: number;
        }) | undefined;
    };
    await expect.poll(async () => {
      const stats = await inbound();
      return Math.min(stats?.packetsLost ?? 0, (stats?.framesDecoded ?? 0) / 10);
    }, { timeout: 30_000, message: "echoed video lost packets and kept decoding" }).toBeGreaterThanOrEqual(8);

    const stats = (await inbound())!;
    expect(stats.fecPacketsReceived, "FEC packets received").toBeGreaterThan(0);
    // Chrome NACKs even when the answer omits it, but Pion runs no NACK responder, so every
    // loss was repaired from FEC before the decoder needed a keyframe.
    expect(stats.retransmittedPacketsReceived ?? 0, "retransmitted packets").toBe(0);
    expect(stats.pliCount ?? 0, "keyframe requests sent").toBe(0);
    // Protecting frames one by one needs at least one FEC packet per frame.
    expect(stats.fecPacketsReceived! * 2, "FEC packets per frame").toBeLessThan(stats.framesDecoded!);
  } finally {
    await media.close();
  }
});
