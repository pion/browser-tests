/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { test, expect, type PionPeer, type RTPObservations } from "../fixtures/interop";
import { audioSink, oscillatorSource } from "../fixtures/media";
import { audioCodecs, content, decodeRED, identity, wireLedger, preferAudioCodecs, requireRED, type Codecs } from "../fixtures/opus-red";

const stats = async (browser: RTCPeerConnection) => Array.from((await browser.getStats()).values());
const inbound = async (browser: RTCPeerConnection) => (await stats(browser)).find(stat =>
  stat.type === "inbound-rtp" && stat.kind === "audio") as RTCInboundRtpStreamStats | undefined;
const decodedSamples = async (browser: RTCPeerConnection) => {
  const received = await inbound(browser);
  return (received?.totalSamplesReceived ?? 0) - (received?.concealedSamples ?? 0);
};

async function waitForAudio(pion: PionPeer, packets: () => Promise<number>) {
  let errors: string[] = [];
  await expect.poll(async () => {
    errors = (await pion.rtp()).errors;
    return errors.length > 0 || await packets() > 25;
  }, { timeout: 15_000 }).toBe(true);
  expect(errors, "Pion RED read/write errors").toEqual([]);
}

function verifyDelivery(observations: RTPObservations, codecs: Codecs) {
  // This no-loss case has independent primary evidence. Never infer sequence
  // identities for unseen copies across browser padding or a missing prefix.
  const received = wireLedger(observations.inbound, codecs, { inferStartup: false });
  const delivered = new Set<string>();
  for (const packet of observations.application) {
    expect(packet.payloadType, "application receives Opus").toBe(codecs.opus);
    expect(delivered.has(identity(packet)), "no duplicate application delivery").toBe(false);
    expect(content(packet), "exact received Opus bytes and RTP identity").toEqual(received.sources.get(identity(packet)));
    delivered.add(identity(packet));
  }
  expect(delivered.size).toBeGreaterThan(25);
  // An inbound carrier may still be waiting for ReadRTP in this live snapshot.
  const origin = observations.inbound[0].sequenceNumber;
  const position = (sequence: number) => (sequence - origin + 0x8000 & 0xffff) - 0x8000;
  const last = Math.max(...observations.application.map(packet => position(packet.sequenceNumber)));
  for (const packet of received.sources.values()) {
    if (position(packet.sequenceNumber) <= last) expect(delivered.has(identity(packet)), "complete delivery before snapshot tail").toBe(true);
  }
  expect(observations.errors).toEqual([]);
  expect(observations.outbound, "receive-only Pion sends no audio").toEqual([]);
  expect(observations.source).toEqual([]);
  expect(observations.droppedOutbound).toEqual([]);
  return { received, delivered };
}

for (const startWithRED of [false, true]) {
  test(startWithRED ? "Opus RED Pion playback starts with RED" : "Opus RED Pion sends audio independently", async ({ interop, skip }) => {
    await requireRED(interop, skip, "Receive");
    const browser = interop.browserPeer();
    const playback = await audioSink(browser);
    try {
      const transceiver = browser.addTransceiver("audio", { direction: "recvonly" });
      preferAudioCodecs(transceiver, "receive");
      const pion = await interop.pionPeer({ behavior: "red-audio-send", opusRED: true, startWithRED });
      await interop.negotiate(browser, pion);
      const codecs = audioCodecs(browser.remoteDescription);
      audioCodecs(browser.localDescription);
      expect(transceiver.currentDirection).toBe("recvonly");
      await waitForAudio(pion, async () => (await inbound(browser))?.packetsReceived ?? 0);
      const before = await decodedSamples(browser);
      await expect.poll(() => decodedSamples(browser), { timeout: 15_000 }).toBeGreaterThan(before + 4800);
      await expect.poll(playback.rms, { timeout: 15_000 }).toBeGreaterThan(0.01);
      expect(playback.receivedTrack()).toBe(true);
      expect(browser.connectionState).toBe("connected");

      await expect.poll(async () => {
        const snapshot = await pion.rtp();
        return { source: snapshot.source.length, wire: snapshot.outbound.length, errors: snapshot.errors };
      }, { timeout: 10_000 }).toEqual({ source: 256, wire: startWithRED ? 255 : 256, errors: [] });

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
        .toEqual(observations.source.slice(startWithRED ? 1 : 0).map(content));
      expect(sent.depths).toContain(1);
      expect(sent.depths).toContain(2);
      expect(Math.max(...sent.depths)).toBe(2);
      if (startWithRED) {
        expect(observations.droppedOutbound, "exactly the initial plain packet was suppressed")
          .toEqual([observations.source[0]]);
        expect(observations.outbound[0].payloadType, "first transmitted media is RED").toBe(codecs.red);
        expect(observations.outbound[0].sequenceNumber).toBe(1001);
        const first = decodeRED(observations.outbound[0].payload);
        expect(first.redundant).toEqual([{ payloadType: codecs.opus, offset: 960, payload: observations.source[0].payload }]);
        expect(sent.sources.get(identity(observations.source[0])), "surviving carrier protects suppressed audio")
          .toEqual(content(observations.source[0]));
      } else {
        expect(observations.droppedOutbound).toEqual([]);
        expect(observations.outbound[0].payloadType, "initial plain Opus followed by RED").toBe(codecs.opus);
        expect(content(observations.outbound[0])).toEqual(content(observations.source[0]));
      }
      expect((await stats(browser)).filter(stat => stat.type === "outbound-rtp" && stat.kind === "audio")
        .every(stat => stat.packetsSent === 0), "receive-only browser sends no audio").toBe(true);
      expect((await pion.rtp()).errors, "no later Pion errors").toEqual([]);
      console.log(`[Opus RED Pion playback${startWithRED ? ", RED first" : ""}] source=${observations.source.length}, ` +
        `wire=${observations.outbound.length}, verified copies=${sent.copies}, dropped=${observations.droppedOutbound.length}, ` +
        `decoded samples=${await decodedSamples(browser)}, non-silent audio, bounded snapshot truncated=${observations.truncated}`);
    } finally {
      await playback.close();
    }
  });
}

for (const undeclared of [false, true]) {
  test(undeclared ? "Opus RED Pion receives undeclared browser audio" : "Opus RED Pion receives browser audio independently", async ({ interop, skip }) => {
    await requireRED(interop, skip, "Send");
    const media = await oscillatorSource();
    try {
      const browser = interop.browserPeer();
      const track = media.stream.getAudioTracks()[0];
      const transceiver = browser.addTransceiver(track, { direction: "sendonly", streams: [media.stream] });
      preferAudioCodecs(transceiver, "send");
      const pion = await interop.pionPeer({ behavior: "red-audio-receive", opusRED: true });
      if (undeclared) {
        await browser.setLocalDescription(await browser.createOffer());
        const offer = await interop.localDescription(browser);
        expect(offer.sdp, "browser originally declares an audio SSRC").toMatch(/^a=ssrc:/m);
        const sdp = offer.sdp!.replace(/^a=ssrc(?:-group)?:[^\r\n]*(?:\r?\n|$)/gm, "");
        await pion.setRemoteDescription({ type: offer.type, sdp });
        await pion.setLocalDescription(await pion.createAnswer());
        await browser.setRemoteDescription(await interop.localDescription(pion));
        expect((await pion.snapshot()).remoteDescription!.sdp, "Pion negotiated without SSRC declarations")
          .not.toMatch(/^a=ssrc(?:-group)?:/m);
      } else await interop.negotiate(browser, pion);
      const codecs = audioCodecs(browser.localDescription);
      audioCodecs(browser.remoteDescription);
      expect(transceiver.currentDirection).toBe("sendonly");
      await waitForAudio(pion, async () => (await pion.rtp()).application.length);
      expect(browser.connectionState).toBe("connected");
      const observations = await pion.rtp();
      const { received, delivered } = verifyDelivery(observations, codecs);
      expect((await stats(browser)).some(stat => stat.type === "outbound-rtp" && stat.kind === "audio" && stat.packetsSent > 25)).toBe(true);
      expect((await stats(browser)).filter(stat => stat.type === "inbound-rtp" && stat.kind === "audio")
        .every(stat => stat.packetsReceived === 0), "send-only browser receives no audio").toBe(true);
      await expect.poll(async () => {
        const stats = Object.values(await pion.stats()) as RTCInboundRtpStreamStats[];
        return stats.find(stat => stat.type === "inbound-rtp" && stat.kind === "audio")?.packetsReceived ?? 0;
      }, { timeout: 5_000 }).toBeGreaterThan(25);
      expect((await pion.rtp()).errors, "no later Pion errors").toEqual([]);
      console.log(`[Opus RED Pion receive${undeclared ? ", undeclared SSRC" : ""}] wire=${observations.inbound.length}, ` +
        `exact Opus deliveries=${delivered.size}, verified copies=${received.copies}, padding=${received.padding}, ` +
        `no audio sent back, bounded snapshot truncated=${observations.truncated}`);
    } finally {
      await media.close();
    }
  });
}
