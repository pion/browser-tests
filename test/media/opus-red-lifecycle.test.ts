/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { test, expect, type ObservedRTP, type RTPObservations } from "../fixtures/interop";
import { audioSink, oscillatorSource } from "../fixtures/media";
import { audioCodecs, content, decodeRED, identity, preferAudioCodecs, wireLedger, type Codecs } from "../fixtures/opus-red";

const audioStats = async (browser: RTCPeerConnection) => Array.from((await browser.getStats()).values())
  .filter(stat => stat.type === "inbound-rtp" && stat.kind === "audio") as RTCInboundRtpStreamStats[];
const samples = (stat: RTCInboundRtpStreamStats | undefined) => (stat?.totalSamplesReceived ?? 0) - (stat?.concealedSamples ?? 0);
const groups = (packets: ObservedRTP[]) => Map.groupBy(packets, packet => packet.ssrc);
const media = (packets: ObservedRTP[]) => packets.filter(packet => packet.payload !== "");

function activeAudioCodecs(description: RTCSessionDescriptionInit | null) {
  const audio = description!.sdp!.split(/(?=^m=)/m).find(section => section.startsWith("m=audio ") &&
    !section.startsWith("m=audio 0 ") && !/^a=inactive\r?$/m.test(section));
  expect(audio, "active audio m-line").toBeDefined();
  return audioCodecs({ type: description!.type, sdp: audio });
}

// Match application audio to observed blocks without predicting recovery or delivery order.
function verifyIncoming(observations: RTPObservations, codecs: Codecs) {
  const streams = groups(observations.inbound);
  expect(Array.from(groups(media(observations.application)).keys()).sort(), "only observed SSRCs reach the application")
    .toEqual(Array.from(streams.keys()).sort());
  for (const [ssrc, packets] of streams) {
    const primaries = new Map<string, ObservedRTP>();
    const redundant: { timestamp: number; payload: string }[] = [];
    let redPackets = 0;
    for (const packet of packets) {
      expect([codecs.opus, codecs.red], "wire payload type is negotiated").toContain(packet.payloadType);
      if (packet.padding && packet.payload === "") continue;
      const decoded = packet.payloadType === codecs.red ? decodeRED(packet.payload) : {
        primary: { payloadType: packet.payloadType, payload: packet.payload }, redundant: [],
      };
      expect(decoded.primary.payloadType, "primary block contains Opus").toBe(codecs.opus);
      expect(decoded.primary.payload.length).toBeGreaterThan(0);
      primaries.set(identity(packet), { ...content(packet), payloadType: codecs.opus, payload: decoded.primary.payload });
      if (packet.payloadType === codecs.red) redPackets++;
      for (const block of decoded.redundant) {
        expect(block.payloadType, "redundant block contains Opus").toBe(codecs.opus);
        expect(block.offset, "redundant block carries earlier audio").toBeGreaterThan(0);
        expect(block.payload.length).toBeGreaterThan(0);
        redundant.push({ timestamp: (packet.timestamp - block.offset) >>> 0, payload: block.payload });
      }
    }
    expect(redPackets, "actual negotiated RED transmission").toBeGreaterThan(5);
    expect(redundant.filter(block => Array.from(primaries.values()).some(packet =>
      packet.timestamp === block.timestamp && packet.payload === block.payload)).length,
    "redundant blocks byte-match independently observed Opus primaries").toBeGreaterThan(5);

    const deliveries = media(observations.application).filter(packet => packet.ssrc === ssrc);
    const delivered = new Set<string>();
    for (const packet of deliveries) {
      expect(packet.payloadType, "application receives Opus").toBe(codecs.opus);
      expect(packet.payload.length).toBeGreaterThan(0);
      expect(delivered.has(identity(packet)), "no duplicate delivery within an SSRC").toBe(false);
      const primary = primaries.get(identity(packet));
      if (primary) {
        expect(content(packet), "delivered Opus matches an observed primary").toEqual(primary);
      } else {
        // RED copies carry timestamps and bytes, but no original sequence number.
        expect(redundant.some(block => block.timestamp === packet.timestamp && block.payload === packet.payload),
          "delivered Opus matches an observed redundant block in this stream").toBe(true);
      }
      delivered.add(identity(packet));
    }
    expect(delivered.size).toBeGreaterThan(25);
  }
  expect(observations.errors).toEqual([]);
  expect(observations.truncated, "lifecycle observations include fresh phases").toBe(false);
  return streams;
}

// Check separate stream identities and correct audio delivery for two browser tracks.
test("Pion keeps two browser RED audio streams separate", async ({ interop, skip }) => {
  await interop.features.require({ skip }, "pion.opusRED", "browser.opusREDSend");
  const sources = await Promise.all([oscillatorSource(440), oscillatorSource(880)]);
  try {
    const browser = interop.browserPeer();
    for (const source of sources) {
      const transceiver = browser.addTransceiver(source.stream.getAudioTracks()[0], { direction: "sendonly", streams: [source.stream] });
      preferAudioCodecs(transceiver, "send");
    }
    const pion = await interop.pionPeer({ behavior: "red-audio-receive", opusRED: true });
    await interop.negotiate(browser, pion);
    await expect.poll(async () => {
      const observation = await pion.rtp();
      expect(observation.errors).toEqual([]);
      const streams = groups(observation.application);
      return streams.size === 2 && Array.from(streams.values()).every(packets => packets.length > 25);
    }, { timeout: 15_000 }).toBe(true);
    const observations = await pion.rtp();
    const streams = verifyIncoming(observations, activeAudioCodecs(browser.localDescription));
    expect(streams.size).toBe(2);
    const deliveries = Array.from(groups(observations.application).values());
    expect(deliveries[0].slice(0, 5).map(packet => packet.payload), "sources have distinguishable audio payloads")
      .not.toEqual(deliveries[1].slice(0, 5).map(packet => packet.payload));
    expect(observations.outbound).toEqual([]);
    console.log(`[RED multiple browser streams] SSRCs=${Array.from(streams.keys())}, exact Opus deliveries=${observations.application.length}`);
  } finally {
    await Promise.all(sources.map(source => source.close()));
  }
});

// Check separate packet histories and audible playback on both browser tracks.
test("Browser plays two separate Pion RED audio streams", async ({ interop, skip }) => {
  await interop.features.require({ skip }, "pion.opusRED", "browser.opusREDReceive");
  const browser = interop.browserPeer();
  const playback = await audioSink(browser);
  try {
    for (let index = 0; index < 2; index++) {
      preferAudioCodecs(browser.addTransceiver("audio", { direction: "recvonly" }), "receive");
    }
    const pion = await interop.pionPeer({ behavior: "red-audio-send", opusRED: true,
      redSource: { tracks: 2 } });
    await interop.negotiate(browser, pion);
    await expect.poll(async () => {
      expect((await pion.rtp()).errors).toEqual([]);
      const stats = await audioStats(browser);
      return stats.length === 2 && stats.every(stat => stat.packetsReceived! > 25);
    }, { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => (await audioStats(browser)).every(stat => samples(stat) > 4800),
      { timeout: 15_000 }).toBe(true);
    expect(playback.sinks.size).toBe(2);
    await expect.poll(playback.rms, { timeout: 15_000 }).toBeGreaterThan(0.01);
    const observations = await pion.rtp();
    expect(observations.errors).toEqual([]);
    const sourceStreams = groups(observations.source);
    expect(sourceStreams.size).toBe(2);
    const codecs = audioCodecs(browser.remoteDescription);
    for (const [ssrc, packets] of sourceStreams) {
      const ledger = wireLedger(observations.outbound.filter(packet => packet.ssrc === ssrc), codecs, { source: packets });
      expect(ledger.primary.size, "each stream transmits matching source Opus").toBeGreaterThan(25);
    }
    const histories = Array.from(sourceStreams.values());
    expect(histories[0].slice(0, 5).map(packet => packet.payload), "Pion histories have distinguishable bytes")
      .not.toEqual(histories[1].slice(0, 5).map(packet => packet.payload));
    expect(observations.truncated).toBe(false);
    expect(observations.inbound).toEqual([]);
    expect(observations.application).toEqual([]);
    console.log(`[RED multiple Pion streams] SSRCs=${Array.from(sourceStreams.keys())}, observed source packets=${observations.source.length}, both decoded non-silent audio`);
  } finally {
    await playback.close();
  }
});
