/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { test, expect, type AudioCodecOrder, type Interop, type PionPeer } from "../fixtures/interop";
import { audioSink, oscillatorSource } from "../fixtures/media";
import { audioCodecs, identity, opusLedger, opusOnlyCodec, preferAudioCodecs, wireLedger } from "../fixtures/opus-red";

type Offerer = "browser" | "pion";
type FallbackCase = {
  name: string;
  offerer: Offerer;
  sender: Offerer;
  browserCodecs: AudioCodecOrder;
  pionCodecs?: AudioCodecOrder;
};

const inbound = async (browser: RTCPeerConnection) => Array.from((await browser.getStats()).values()).find(stat =>
  stat.type === "inbound-rtp" && stat.kind === "audio") as RTCInboundRtpStreamStats | undefined;
const decodedSamples = async (browser: RTCPeerConnection) => {
  const received = await inbound(browser);
  return (received?.totalSamplesReceived ?? 0) - (received?.concealedSamples ?? 0);
};

async function negotiate(interop: Interop, browser: RTCPeerConnection, pion: PionPeer, offerer: Offerer,
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
  transceiver.direction = "recvonly";
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
  await expect.poll(() => decodedSamples(browser), { timeout: 15_000 }).toBeGreaterThan(4800);
  await expect.poll(playback.rms, { timeout: 15_000 }).toBeGreaterThan(0.01);
  expect(playback.receivedTrack()).toBe(true);
  expect(browser.connectionState).toBe("connected");
  const observations = await pion.rtp();
  expect(observations.errors).toEqual([]);
  expect(observations.truncated, "playback evidence is not truncated").toBe(false);
  expect(observations.inbound, "Pion only sends audio").toEqual([]);
  expect(observations.application).toEqual([]);
  return observations;
}

// Check negotiation, packet identifiers, and playback with non-default codec mappings.
test("Browser plays RED using payload types 109 and 112", async ({ interop, skip }) => {
  const pair = { opus: 109, red: 112 };
  await interop.features.require({ skip }, "pion.opusRED", "browser.opusREDReceive");
  const browser = interop.browserPeer();
  const playback = await audioSink(browser);
  try {
    const pion = await interop.pionPeer({ behavior: "red-audio-send", opusRED: true,
      opusREDPayloadTypes: pair, audioCodecOrder: "red-first" });
    const transceiver = await negotiate(interop, browser, pion, "pion", "receive", "red-first");
    const negotiated = audioCodecs(browser.remoteDescription);
    expect(negotiated, "both descriptions retain the RED/Opus association")
      .toEqual(audioCodecs(browser.localDescription));
    expect(negotiated, "Pion offers the configured payload pair").toEqual(pair);
    const offer = browser.remoteDescription;
    const audio = offer!.sdp.split(/(?=^m=)/m).find(section => section.startsWith("m=audio "))!;
    const payloads = audio.split(/\r?\n/)[0].split(" ").slice(3).map(Number);
    expect(payloads[0], "offered codec preference order")
      .toBe(negotiated.red);
    expect(transceiver.currentDirection).toBe("recvonly");

    const observations = await verifyPlayback(browser, pion, playback);
    const ledger = wireLedger(observations.outbound, negotiated, { source: observations.source });
    expect(ledger.primary.size, "enough transmitted Opus primaries match the source").toBeGreaterThan(25);
    expect(observations.source.every(packet => packet.payloadType === negotiated.opus)).toBe(true);
    expect(observations.outbound[0].payloadType, "initial packet is Opus").toBe(negotiated.opus);
    expect(observations.outbound.slice(1).every(packet => packet.payloadType === negotiated.red), "subsequent audio is RED").toBe(true);
    expect(ledger.depths).toContain(1);
    expect(ledger.depths).toContain(2);
    expect(Math.max(...ledger.depths)).toBe(2);
    expect((await pion.rtp()).errors).toEqual([]);
    console.log(`[RED negotiation Pion offers] configured=${pair.opus}/${pair.red}, ` +
      `negotiated=${negotiated.opus}/${negotiated.red}, exact primaries=${ledger.primary.size}, ` +
      `verified copies=${ledger.copies}, decoded samples=${await decodedSamples(browser)}, non-silent audio`);
  } finally {
    await playback.close();
  }
});

async function playOpusAudio(interop: Interop, scenario: FallbackCase) {
  const { offerer, browserCodecs, pionCodecs } = scenario;
  const browser = interop.browserPeer();
  const playback = await audioSink(browser);
  try {
    const pion = await interop.pionPeer({ behavior: "red-audio-send", opusRED: true,
      audioCodecOrder: pionCodecs });
    await negotiate(interop, browser, pion, offerer, "receive", browserCodecs);
    const answer = offerer === "browser" ? browser.remoteDescription : browser.localDescription;
    const opus = opusOnlyCodec(answer);
    if (browserCodecs === "red-first") {
      expect(audioCodecs(browser.localDescription).opus, "RED offer and Opus-only answer agree on Opus")
        .toBe(opus);
    }
    const observations = await verifyPlayback(browser, pion, playback);
    const ledger = opusLedger(observations.outbound, opus, observations.source);
    expect(ledger.primary.size, "enough transmitted Opus primaries match the source").toBeGreaterThan(25);
    console.log(`[Opus fallback Pion sends, ${offerer} offers] payload type=${opus}, ` +
      `exact packets=${ledger.primary.size}, decoded samples=${await decodedSamples(browser)}, non-silent audio, no RED on wire`);
  } finally {
    await playback.close();
  }
}

async function receiveOpusAudio(interop: Interop, scenario: FallbackCase) {
  const { offerer, browserCodecs, pionCodecs } = scenario;
  const media = await oscillatorSource();
  try {
    const browser = interop.browserPeer();
    const pion = await interop.pionPeer({ behavior: "red-audio-receive", opusRED: true,
      audioCodecOrder: pionCodecs });
    const transceiver = await negotiate(interop, browser, pion, offerer, "send", browserCodecs, media.stream);
    const answer = offerer === "browser" ? browser.remoteDescription : browser.localDescription;
    const opus = opusOnlyCodec(answer);
    if (offerer === "pion") {
      const offer = browser.remoteDescription!;
      const offered = audioCodecs(offer);
      const audio = offer.sdp!.split(/(?=^m=)/m).find(section => section.startsWith("m=audio "))!;
      expect(audio.split(/\r?\n/)[0].split(" ").slice(3, 5).map(Number), "Pion still offers Opus and RED")
        .toEqual([offered.opus, offered.red]);
      expect(offered.opus).toBe(opus);
    }
    await expect.poll(async () => {
      const observations = await pion.rtp();
      return observations.errors.length > 0 || observations.inbound.filter(packet => packet.payload !== "").length > 25;
    }, { timeout: 15_000 }).toBe(true);
    const inbound = await pion.rtp();
    expect(inbound.errors).toEqual([]);
    expect(inbound.inbound.every(packet => packet.payloadType === opus),
      "inbound RTP uses negotiated Opus, not unnegotiated RED").toBe(true);
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
    expect(transceiver.currentDirection).toBe("sendonly");
    expect(browser.connectionState).toBe("connected");
    console.log(`[Opus fallback browser sends, ${offerer} offers] payload type=${opus}, ` +
      `exact deliveries=${delivered.primary.size}, padding=${received.padding}/${delivered.padding}, no RED on wire`);
  } finally {
    await media.close();
  }
}

const fallbackCases: FallbackCase[] = [
  { name: "Browser offers Opus only and plays Pion audio", offerer: "browser", sender: "pion",
    browserCodecs: "opus-only" },
  { name: "Pion answers a RED offer with Opus-only audio", offerer: "browser", sender: "pion",
    browserCodecs: "red-first", pionCodecs: "opus-only" },
  { name: "Browser offers Opus only and Pion receives audio", offerer: "browser", sender: "browser",
    browserCodecs: "opus-only" },
  { name: "Pion offers RED and browser plays Opus-only audio", offerer: "pion", sender: "pion",
    browserCodecs: "opus-only" },
  // Chrome can transmit unnegotiated RED after an Opus-only answer to a RED-first offer.
  // Exercise the passing Opus-first offer here; RED-first needs separate browser-version coverage.
  { name: "Pion offers RED with Opus first and receives Opus-only browser audio", offerer: "pion", sender: "browser",
    browserCodecs: "opus-only", pionCodecs: "opus-first" },
];

for (const scenario of fallbackCases) {
  test(scenario.name, async ({ interop, skip }) => {
    await interop.features.require({ skip }, "pion.opusRED");
    if (scenario.browserCodecs === "red-first") {
      await interop.features.require({ skip }, "browser.opusREDReceive");
    }
    if (scenario.sender === "pion") {
      await playOpusAudio(interop, scenario);
    } else {
      await receiveOpusAudio(interop, scenario);
    }
  });
}
