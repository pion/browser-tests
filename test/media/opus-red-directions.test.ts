/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { test, expect } from "../fixtures/interop";
import { audioSink } from "../fixtures/media";
import { audioCodecs, content, decodeRED, identity, wireLedger, preferAudioCodecs } from "../fixtures/opus-red";

const stats = async (browser: RTCPeerConnection) => Array.from((await browser.getStats()).values());
const inbound = async (browser: RTCPeerConnection) => (await stats(browser)).find(stat =>
  stat.type === "inbound-rtp" && stat.kind === "audio") as RTCInboundRtpStreamStats | undefined;
const decodedSamples = async (browser: RTCPeerConnection) => {
  const received = await inbound(browser);
  return (received?.totalSamplesReceived ?? 0) - (received?.concealedSamples ?? 0);
};

// Check that playback starts when the first arriving audio packet is RED.
test("Browser plays audio when Pion starts with RED", async ({ interop, skip }) => {
  await interop.features.require({ skip }, "pion.opusRED", "browser.opusREDReceive");
  const browser = interop.browserPeer();
  const playback = await audioSink(browser);
  try {
    const transceiver = browser.addTransceiver("audio", { direction: "recvonly" });
    preferAudioCodecs(transceiver, "receive");
    const pion = await interop.pionPeer({ behavior: "red-audio-send", opusRED: true, startWithRED: true });
    await interop.negotiate(browser, pion);
    const codecs = audioCodecs(browser.remoteDescription);
    audioCodecs(browser.localDescription);
    expect(transceiver.currentDirection).toBe("recvonly");
    let errors: string[] = [];
    await expect.poll(async () => {
      errors = (await pion.rtp()).errors;
      return errors.length > 0 || ((await inbound(browser))?.packetsReceived ?? 0) > 25;
    }, { timeout: 15_000 }).toBe(true);
    expect(errors, "Pion RED read/write errors").toEqual([]);
    const before = await decodedSamples(browser);
    await expect.poll(() => decodedSamples(browser), { timeout: 15_000 }).toBeGreaterThan(before + 4800);
    await expect.poll(playback.rms, { timeout: 15_000 }).toBeGreaterThan(0.01);
    expect(playback.receivedTrack()).toBe(true);
    expect(browser.connectionState).toBe("connected");

    await expect.poll(async () => {
      const snapshot = await pion.rtp();
      return { source: snapshot.source.length, wire: snapshot.outbound.length, errors: snapshot.errors };
    }, { timeout: 10_000 }).toEqual({ source: 256, wire: 255, errors: [] });

    const observations = await pion.rtp();
    expect(observations.errors).toEqual([]);
    expect(observations.inbound, "send-only Pion receives no audio").toEqual([]);
    expect(observations.application).toEqual([]);
    expect(observations.source).toHaveLength(256);
    expect(observations.truncated, "complete playback packet evidence").toBe(false);
    observations.source.forEach((packet, index) => {
      expect(packet.payloadType).toBe(codecs.opus);
      expect(packet.sequenceNumber).toBe(1000 + index);
      expect(packet.timestamp).toBe(48000 + 960 * index);
      expect(packet.ssrc).toBe(observations.outbound[0].ssrc);
      expect(packet.payload.length).toBeGreaterThan(0);
    });
    const sent = wireLedger(observations.outbound, codecs, { source: observations.source });
    expect(Array.from(sent.primary.values()), "every transmitted primary matches its source exactly once")
      .toEqual(observations.source.slice(1).map(content));
    expect(sent.depths).toContain(1);
    expect(sent.depths).toContain(2);
    expect(Math.max(...sent.depths)).toBe(2);
    expect(observations.droppedOutbound, "exactly the initial plain packet was suppressed")
      .toEqual([observations.source[0]]);
    expect(observations.outbound[0].payloadType, "first transmitted media is RED").toBe(codecs.red);
    expect(observations.outbound[0].sequenceNumber).toBe(1001);
    const first = decodeRED(observations.outbound[0].payload);
    expect(first.redundant).toEqual([{ payloadType: codecs.opus, offset: 960, payload: observations.source[0].payload }]);
    expect(sent.sources.get(identity(observations.source[0])), "surviving carrier protects suppressed audio")
      .toEqual(content(observations.source[0]));
    expect((await stats(browser)).filter(stat => stat.type === "outbound-rtp" && stat.kind === "audio")
      .every(stat => stat.packetsSent === 0), "receive-only browser sends no audio").toBe(true);
    expect((await pion.rtp()).errors, "no later Pion errors").toEqual([]);
    console.log(`[RED-first Pion playback] source=${observations.source.length}, ` +
      `wire=${observations.outbound.length}, verified copies=${sent.copies}, dropped=${observations.droppedOutbound.length}, ` +
      `decoded samples=${await decodedSamples(browser)}, non-silent audio, bounded snapshot truncated=${observations.truncated}`);
  } finally {
    await playback.close();
  }
});
