/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { test, expect, type AudioCodecOrder, type Interop, type PionPeer } from "../fixtures/interop";
import { audioSink, oscillatorSource } from "../fixtures/media";
import { audioCodecs, content, identity, opusLedger, opusOnlyCodec, preferAudioCodecs, requireRED, wireLedger } from "../fixtures/opus-red";

const pairs = [{ opus: 111, red: 63 }, { opus: 109, red: 112 }, { opus: 96, red: 127 }];
const offerers = ["browser", "pion"] as const;

const inbound = async (browser: RTCPeerConnection) => Array.from((await browser.getStats()).values()).find(stat =>
  stat.type === "inbound-rtp" && stat.kind === "audio") as RTCInboundRtpStreamStats | undefined;
const decodedSamples = async (browser: RTCPeerConnection) => {
  const received = await inbound(browser);
  return (received?.totalSamplesReceived ?? 0) - (received?.concealedSamples ?? 0);
};

async function negotiate(interop: Interop, browser: RTCPeerConnection, pion: PionPeer, offerer: typeof offerers[number],
  direction: "send" | "receive", order: AudioCodecOrder, stream?: MediaStream): Promise<RTCRtpTransceiver> {
  if (offerer === "browser") {
    const transceiver = direction === "receive" ? browser.addTransceiver("audio", { direction: "recvonly" }) :
      browser.addTransceiver(stream!.getAudioTracks()[0], { direction: "sendonly", streams: [stream!] });
    preferAudioCodecs(transceiver, direction, order);
    await interop.negotiate(browser, pion);
    return transceiver;
  }
  if (direction === "send") {
    // The source and native Opus-only preference exist before Pion's offer.
    const sender = browser.addTrack(stream!.getAudioTracks()[0], stream!);
    const transceiver = browser.getTransceivers().find(transceiver => transceiver.sender === sender)!;
    preferAudioCodecs(transceiver, direction, order);
    await interop.negotiate(pion, browser);
    return transceiver;
  }
  await pion.setLocalDescription(await pion.createOffer());
  await browser.setRemoteDescription(await interop.localDescription(pion));
  // Apply preferences to the transceiver created for this offered m-line. A
  // precreated recvonly transceiver can remain unused when Pion offers sendonly.
  const transceiver = browser.getTransceivers().find(transceiver =>
    transceiver.mid !== null && transceiver.receiver.track.kind === "audio")!;
  expect(transceiver, "offered audio transceiver").toBeDefined();
  transceiver.direction = direction === "receive" ? "recvonly" : "sendonly";
  preferAudioCodecs(transceiver, direction, order);
  await browser.setLocalDescription(await browser.createAnswer());
  await pion.setRemoteDescription(await interop.localDescription(browser));
  return transceiver;
}

async function verifyPlayback(browser: RTCPeerConnection, pion: PionPeer, playback: Awaited<ReturnType<typeof audioSink>>) {
  let errors: string[] = [];
  await expect.poll(async () => {
    errors = (await pion.rtp()).errors;
    return errors.length > 0 || ((await inbound(browser))?.packetsReceived ?? 0) > 25;
  }, { timeout: 15_000 }).toBe(true);
  expect(errors, "Pion playback has no read/write errors").toEqual([]);
  const before = await decodedSamples(browser);
  await expect.poll(() => decodedSamples(browser), { timeout: 15_000 }).toBeGreaterThan(before + 4800);
  await expect.poll(playback.rms, { timeout: 15_000 }).toBeGreaterThan(0.01);
  expect(playback.receivedTrack()).toBe(true);
  expect(browser.connectionState).toBe("connected");
  await expect.poll(async () => {
    const observation = await pion.rtp();
    return { source: observation.source.length, wire: observation.outbound.length, errors: observation.errors };
  }, { timeout: 10_000 }).toEqual({ source: 256, wire: 256, errors: [] });
  const observations = await pion.rtp();
  expect(observations.truncated, "complete playback evidence").toBe(false);
  expect(observations.inbound, "Pion only sends audio").toEqual([]);
  expect(observations.application).toEqual([]);
  expect(observations.droppedOutbound).toEqual([]);
  return observations;
}

for (const pair of pairs) {
  for (const offerer of offerers) {
    for (const order of ["red-first", "opus-first"] as const) {
      test(`Opus RED negotiates ${pair.opus}/${pair.red}, ${order} (${offerer} offers)`, async ({ interop, skip }) => {
        await requireRED(interop, skip, "Receive");
        const browser = interop.browserPeer();
        const playback = await audioSink(browser);
        try {
          const pion = await interop.pionPeer({ behavior: "red-audio-send", opusRED: true,
            opusREDPayloadTypes: pair, audioCodecOrder: order });
          const transceiver = await negotiate(interop, browser, pion, offerer, "receive", order);
          const negotiated = audioCodecs(browser.remoteDescription);
          expect(negotiated, "both descriptions retain the RED/Opus association")
            .toEqual(audioCodecs(browser.localDescription));
          if (offerer === "pion") expect(negotiated, "Pion offers the configured payload pair").toEqual(pair);
          const offer = offerer === "browser" ? browser.localDescription : browser.remoteDescription;
          const audio = offer!.sdp.split(/(?=^m=)/m).find(section => section.startsWith("m=audio "))!;
          const payloads = audio.split(/\r?\n/)[0].split(" ").slice(3).map(Number);
          expect(payloads[0], "offered codec preference order")
            .toBe(order === "red-first" ? negotiated.red : negotiated.opus);
          expect(transceiver.currentDirection).toBe("recvonly");

          const observations = await verifyPlayback(browser, pion, playback);
          const ledger = wireLedger(observations.outbound, negotiated, { source: observations.source });
          expect(Array.from(ledger.primary.values()), "all transmitted Opus identities match the source exactly once")
            .toEqual(observations.source.map(content));
          expect(observations.source.every(packet => packet.payloadType === negotiated.opus)).toBe(true);
          expect(observations.outbound[0].payloadType, "initial packet is Opus").toBe(negotiated.opus);
          expect(observations.outbound.slice(1).every(packet => packet.payloadType === negotiated.red), "subsequent audio is RED").toBe(true);
          expect(ledger.depths).toContain(1);
          expect(ledger.depths).toContain(2);
          expect(Math.max(...ledger.depths)).toBe(2);
          expect((await pion.rtp()).errors).toEqual([]);
          console.log(`[RED negotiation ${offerer}, ${order}] configured=${pair.opus}/${pair.red}, ` +
            `negotiated=${negotiated.opus}/${negotiated.red}, exact primaries=${ledger.primary.size}, ` +
            `verified copies=${ledger.copies}, decoded samples=${await decodedSamples(browser)}, non-silent audio`);
        } finally {
          await playback.close();
        }
      });
    }
  }
}

for (const offerer of offerers) {
  test(`Opus-only fallback from RED-enabled Pion (${offerer} offers)`, async ({ interop, skip }) => {
    // This must run even when the browser cannot receive RED.
    await requireRED(interop, skip);
    const browser = interop.browserPeer();
    const playback = await audioSink(browser);
    try {
      const pion = await interop.pionPeer({ behavior: "red-audio-send", opusRED: true });
      await negotiate(interop, browser, pion, offerer, "receive", "opus-only");
      const answer = offerer === "browser" ? browser.remoteDescription : browser.localDescription;
      const opus = opusOnlyCodec(answer);
      const observations = await verifyPlayback(browser, pion, playback);
      const ledger = opusLedger(observations.outbound, opus, observations.source);
      expect(Array.from(ledger.primary.values()), "plain playback preserves every source packet")
        .toEqual(observations.source.map(content));
      console.log(`[Opus fallback Pion sends, ${offerer} offers] payload type=${opus}, ` +
        `exact packets=${ledger.primary.size}, decoded samples=${await decodedSamples(browser)}, non-silent audio, no RED on wire`);
    } finally {
      await playback.close();
    }
  });

  test(`Opus-only fallback into RED-enabled Pion (${offerer} offers)`, async ({ interop, skip }) => {
    // This must run even when the browser cannot send RED.
    await requireRED(interop, skip);
    const media = await oscillatorSource();
    try {
      const browser = interop.browserPeer();
      const pion = await interop.pionPeer({ behavior: "red-audio-receive", opusRED: true });
      const transceiver = await negotiate(interop, browser, pion, offerer, "send", "opus-only", media.stream);
      const answer = offerer === "browser" ? browser.remoteDescription : browser.localDescription;
      const opus = opusOnlyCodec(answer);
      let errors: string[] = [];
      await expect.poll(async () => {
        const observations = await pion.rtp();
        errors = observations.errors;
        return errors.length > 0 || observations.application.filter(packet => packet.payload !== "").length > 25;
      }, { timeout: 15_000 }).toBe(true);
      expect(errors).toEqual([]);
      const observations = await pion.rtp();
      const received = opusLedger(observations.inbound, opus);
      const delivered = opusLedger(observations.application, opus, Array.from(received.primary.values()));
      const origin = observations.inbound[0].sequenceNumber;
      const position = (sequence: number) => (sequence - origin + 0x8000 & 0xffff) - 0x8000;
      const last = Math.max(...Array.from(delivered.primary.values()).map(packet => position(packet.sequenceNumber)));
      for (const packet of received.primary.values()) {
        if (position(packet.sequenceNumber) <= last) expect(delivered.primary.has(identity(packet)), "complete Opus delivery before snapshot tail").toBe(true);
      }
      expect(observations.errors).toEqual([]);
      expect(observations.outbound).toEqual([]);
      expect(observations.source).toEqual([]);
      expect(observations.droppedOutbound).toEqual([]);
      expect(transceiver.currentDirection).toBe("sendonly");
      expect(browser.connectionState).toBe("connected");
      console.log(`[Opus fallback browser sends, ${offerer} offers] payload type=${opus}, ` +
        `exact deliveries=${delivered.primary.size}, padding=${received.padding}/${delivered.padding}, no RED on wire`);
    } finally {
      await media.close();
    }
  });
}
