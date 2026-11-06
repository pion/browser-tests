/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { test, expect } from "../fixtures/interop";
import { audioSink } from "../fixtures/media";
import { audioCodecs, wireLedger, preferAudioCodecs } from "../fixtures/opus-red";

const stats = async (browser: RTCPeerConnection) => Array.from((await browser.getStats()).values());
const inbound = async (browser: RTCPeerConnection) => (await stats(browser)).find(stat =>
  stat.type === "inbound-rtp" && stat.kind === "audio") as RTCInboundRtpStreamStats | undefined;
const decodedSamples = async (browser: RTCPeerConnection) => {
  const received = await inbound(browser);
  return (received?.totalSamplesReceived ?? 0) - (received?.concealedSamples ?? 0);
};

// Check RED transmission and decoded, non-silent browser playback.
test("Browser decodes and plays Pion RED audio", async ({ interop, skip }) => {
  await interop.features.require({ skip }, "pion.opusRED", "browser.opusREDReceive");
  const browser = interop.browserPeer();
  const playback = await audioSink(browser);
  try {
    const transceiver = browser.addTransceiver("audio", { direction: "recvonly" });
    preferAudioCodecs(transceiver, "receive");
    const pion = await interop.pionPeer({ behavior: "red-audio-send", opusRED: true });
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
    await expect.poll(() => decodedSamples(browser), { timeout: 15_000 }).toBeGreaterThan(4800);
    await expect.poll(playback.rms, { timeout: 15_000 }).toBeGreaterThan(0.01);
    expect(playback.receivedTrack()).toBe(true);
    expect(browser.connectionState).toBe("connected");

    const observations = await pion.rtp();
    expect(observations.errors).toEqual([]);
    expect(observations.inbound, "send-only Pion receives no audio").toEqual([]);
    expect(observations.application).toEqual([]);
    expect(observations.truncated, "playback packet evidence is not truncated").toBe(false);
    const sent = wireLedger(observations.outbound, codecs, { source: observations.source });
    expect(sent.primary.size, "enough transmitted Opus primaries match the source").toBeGreaterThan(25);
    expect(sent.depths).toContain(1);
    expect(sent.depths).toContain(2);
    expect(Math.max(...sent.depths)).toBe(2);
    expect(observations.outbound[0].payloadType, "initial packet is Opus").toBe(codecs.opus);
    expect(observations.outbound.slice(1).every(packet => packet.payloadType === codecs.red),
      "subsequent audio is RED").toBe(true);
    expect((await stats(browser)).filter(stat => stat.type === "outbound-rtp" && stat.kind === "audio")
      .every(stat => stat.packetsSent === 0), "receive-only browser sends no audio").toBe(true);
    expect((await pion.rtp()).errors, "no later Pion errors").toEqual([]);
    console.log(`[Pion RED playback] source=${observations.source.length}, ` +
      `wire=${observations.outbound.length}, verified copies=${sent.copies}, ` +
      `decoded samples=${await decodedSamples(browser)}, non-silent audio, bounded snapshot truncated=${observations.truncated}`);
  } finally {
    await playback.close();
  }
});
