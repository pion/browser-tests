/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { test, expect, type ObservedRTP, type PionPeer, type RTPObservations } from "../fixtures/interop";
import { audioSink, mediaSource, oscillatorSource } from "../fixtures/media";
import { audioCodecs, content, decodeRED, identity, preferAudioCodecs, requireRED, wireLedger, type Codecs } from "../fixtures/opus-red";
import { expectedDeliveries } from "../fixtures/red-recovery";

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

// ICE transitions can lose carrier primaries. RED preserves the missing copy's
// bytes/timestamp, but not its original sequence number. Those identities are
// checked against the receiver's contiguous-copy contract and reported as
// inferred; controlled recovery tests retain independent source identities.
function transitionOutputs(packets: ObservedRTP[], codecs: Codecs) {
  const primaries = new Map<string, ObservedRTP>();
  const copies: { carrier: ObservedRTP; blocks: ReturnType<typeof decodeRED>["redundant"] }[] = [];
  for (const carrier of packets) {
    expect([codecs.opus, codecs.red], "lifecycle wire payload is negotiated").toContain(carrier.payloadType);
    if (carrier.padding && carrier.payload === "") continue;
    const decoded = carrier.payloadType === codecs.red ? decodeRED(carrier.payload) : {
      redundant: [], primary: { payloadType: carrier.payloadType, payload: carrier.payload, offset: 0 },
    };
    expect(decoded.primary.payloadType).toBe(codecs.opus);
    expect(decoded.primary.payload.length, "nonempty primary Opus").toBeGreaterThan(0);
    const primary = { ...content(carrier), payloadType: codecs.opus, payload: decoded.primary.payload };
    expect(primaries.has(identity(primary)), "no duplicate observed carrier identity").toBe(false);
    primaries.set(identity(primary), primary);
    copies.push({ carrier, blocks: decoded.redundant });
  }
  const source = new Map(primaries);
  const inferred = new Set<string>();
  let verifiedCopies = 0;
  for (const { carrier, blocks } of copies) {
    blocks.forEach((block, index) => {
      expect(block.payloadType).toBe(codecs.opus);
      expect(block.offset).toBeGreaterThan(0);
      expect(block.payload.length).toBeGreaterThan(0);
      const timestamp = (carrier.timestamp - block.offset) >>> 0;
      const known = Array.from(primaries.values()).filter(packet => packet.timestamp === timestamp && packet.payload === block.payload);
      expect(known.length, "copy belongs to at most one observed primary in this SSRC").toBeLessThanOrEqual(1);
      if (known.length) { verifiedCopies++; return; }
      const copy = { ...content(carrier), payloadType: codecs.opus, payload: block.payload, timestamp,
        sequenceNumber: (carrier.sequenceNumber - blocks.length + index) & 0xffff };
      const previous = source.get(identity(copy));
      if (previous) expect(content(copy), "consistent copy bytes and RTP identity across carriers").toEqual(previous);
      source.set(identity(copy), copy);
      inferred.add(identity(copy));
    });
  }
  expect(verifiedCopies, "useful independently verified RED copies remain present").toBeGreaterThan(5);
  const origin = packets[0].sequenceNumber;
  const position = (sequence: number) => (sequence - origin + 0x8000 & 0xffff) - 0x8000;
  const sorted = Array.from(source.values()).sort((left, right) => position(left.sequenceNumber) - position(right.sequenceNumber));
  return { outputs: expectedDeliveries(sorted, packets, codecs), inferred: inferred.size,
    maxPending: Math.max(...copies.map(copy => copy.blocks.length)) + 1 };
}

function verifyIncoming(observations: RTPObservations, codecs: Codecs, transitionLoss = false) {
  const streams = groups(observations.inbound);
  expect(Array.from(groups(media(observations.application)).keys()).sort(), "only observed SSRCs reach the application")
    .toEqual(Array.from(streams.keys()).sort());
  for (const [ssrc, packets] of streams) {
    const deliveries = media(observations.application).filter(packet => packet.ssrc === ssrc);
    if (transitionLoss) {
      const expected = transitionOutputs(packets, codecs);
      expect(deliveries.map(content), "exact per-carrier Opus recovery order, including every completed carrier")
        .toEqual(expected.outputs.slice(0, deliveries.length));
      expect(expected.outputs.length - deliveries.length, "only the final carrier may be pending in a live snapshot")
        .toBeLessThanOrEqual(expected.maxPending);
      expect(new Set(deliveries.map(identity)).size, "no duplicate application deliveries").toBe(deliveries.length);
      expect(deliveries.length).toBeGreaterThan(25);
      console.log(`[RED lifecycle SSRC ${ssrc}] exact observed primaries and decoded copies; ` +
        `copy identities inferred from receiver contract=${expected.inferred}; independent lost-header proof requires controlled source`);
      continue;
    }
    const ledger = wireLedger(packets, codecs, { inferStartup: false });
    const delivered = new Set<string>();
    for (const packet of deliveries) {
      expect(delivered.has(identity(packet)), "no duplicate delivery within an SSRC").toBe(false);
      expect(content(packet), "delivered Opus belongs to this stream's own carriers").toEqual(ledger.sources.get(identity(packet)));
      delivered.add(identity(packet));
    }
    expect(delivered.size).toBeGreaterThan(25);
    const origin = packets[0].sequenceNumber;
    const position = (sequence: number) => (sequence - origin + 0x8000 & 0xffff) - 0x8000;
    const tail = Math.max(...deliveries.map(packet => position(packet.sequenceNumber)));
    for (const source of ledger.sources.values()) {
      if (position(source.sequenceNumber) <= tail) expect(delivered.has(identity(source)), "complete delivery before snapshot tail").toBe(true);
    }
  }
  expect(observations.errors).toEqual([]);
  expect(observations.truncated, "lifecycle observations include fresh phases").toBe(false);
  return streams;
}

// One muted sink and analyser for each track prevents a working stream from
// masking silent audio on another stream.
async function multiAudioSink(browser: RTCPeerConnection) {
  const context = new AudioContext();
  const sinks = new Map<string, { element: HTMLVideoElement; rms: () => number }>();
  const receive = ({ track }: RTCTrackEvent) => {
    if (track.kind !== "audio") return;
    const element = document.createElement("video");
    element.autoplay = element.playsInline = element.muted = true;
    element.srcObject = new MediaStream([track]);
    document.body.append(element);
    const analyser = context.createAnalyser();
    const output = context.createGain();
    output.gain.value = 0;
    context.createMediaStreamSource(element.srcObject).connect(analyser).connect(output).connect(context.destination);
    const waveform = new Float32Array(analyser.fftSize);
    sinks.set(track.id, { element, rms: () => {
      analyser.getFloatTimeDomainData(waveform);
      return Math.sqrt(waveform.reduce((sum, sample) => sum + sample * sample, 0) / waveform.length);
    } });
  };
  browser.addEventListener("track", receive);
  await context.resume();
  return { sinks, close: async () => {
    browser.removeEventListener("track", receive);
    for (const { element } of sinks.values()) {
      element.pause(); element.srcObject = null; element.remove();
    }
    await context.close();
  } };
}

test("Opus RED isolates two browser audio SSRCs", async ({ interop, skip }) => {
  await requireRED(interop, skip, "Send");
  const sources = await Promise.all([oscillatorSource(440), oscillatorSource(880)]);
  try {
    const browser = interop.browserPeer();
    for (const source of sources) {
      const transceiver = browser.addTransceiver(source.stream.getAudioTracks()[0], { direction: "sendonly", streams: [source.stream] });
      preferAudioCodecs(transceiver, "send");
    }
    const pion = await interop.pionPeer({ behavior: "red-audio-receive", opusRED: true, observationLimit: 2048 });
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

test("Opus RED isolates two Pion audio SSRCs", async ({ interop, skip }) => {
  await requireRED(interop, skip, "Receive");
  const browser = interop.browserPeer();
  const playback = await multiAudioSink(browser);
  try {
    for (let index = 0; index < 2; index++) {
      preferAudioCodecs(browser.addTransceiver("audio", { direction: "recvonly" }), "receive");
    }
    const pion = await interop.pionPeer({ behavior: "red-audio-send", opusRED: true,
      observationLimit: 2048, redSource: { tracks: 2, packets: 256 } });
    await interop.negotiate(browser, pion);
    await expect.poll(async () => {
      expect((await pion.rtp()).errors).toEqual([]);
      const stats = await audioStats(browser);
      return stats.length === 2 && stats.every(stat => stat.packetsReceived! > 25);
    }, { timeout: 15_000 }).toBe(true);
    const before = new Map((await audioStats(browser)).map(stat => [stat.ssrc, samples(stat)]));
    await expect.poll(async () => (await audioStats(browser)).every(stat => samples(stat) > before.get(stat.ssrc)! + 4800),
      { timeout: 15_000 }).toBe(true);
    expect(playback.sinks.size).toBe(2);
    await expect.poll(() => Array.from(playback.sinks.values()).every(sink => sink.rms() > 0.01), { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => {
      const observation = await pion.rtp();
      return { source: observation.source.length, media: media(observation.outbound).length, done: observation.sourceDone, errors: observation.errors };
    }, { timeout: 10_000 }).toEqual({ source: 512, media: 512, done: true, errors: [] });
    const observations = await pion.rtp();
    const sourceStreams = groups(observations.source);
    expect(sourceStreams.size).toBe(2);
    const codecs = audioCodecs(browser.remoteDescription);
    for (const [ssrc, packets] of sourceStreams) {
      const ledger = wireLedger(observations.outbound.filter(packet => packet.ssrc === ssrc), codecs, { source: packets });
      expect(Array.from(ledger.primary.values()), "each sender has its own complete source history").toEqual(packets.map(content));
      expect(packets).toHaveLength(256);
    }
    const histories = Array.from(sourceStreams.values());
    expect(histories[0].slice(0, 5).map(packet => packet.payload), "Pion histories have distinguishable bytes")
      .not.toEqual(histories[1].slice(0, 5).map(packet => packet.payload));
    expect(observations.truncated).toBe(false);
    expect(observations.inbound).toEqual([]);
    expect(observations.application).toEqual([]);
    console.log(`[RED multiple Pion streams] SSRCs=${Array.from(sourceStreams.keys())}, exact primary packets=${observations.source.length}, both decoded non-silent audio`);
  } finally {
    await playback.close();
  }
});

test("Opus RED browser track replacement preserves its SSRC and fresh audio", async ({ interop, skip }) => {
  await requireRED(interop, skip, "Send");
  const sources = await Promise.all([oscillatorSource(440), oscillatorSource(880)]);
  try {
    const browser = interop.browserPeer();
    const audio = browser.addTransceiver(sources[0].stream.getAudioTracks()[0], { direction: "sendonly", streams: [sources[0].stream] });
    preferAudioCodecs(audio, "send");
    const pion = await interop.pionPeer({ behavior: "red-audio-receive", opusRED: true, observationLimit: 2048 });
    await interop.negotiate(browser, pion);
    await expect.poll(async () => (await pion.rtp()).application.length, { timeout: 15_000 }).toBeGreaterThan(25);
    const before = await pion.rtp();
    expect(before.errors).toEqual([]);
    const ssrc = before.application[0].ssrc;
    const description = browser.localDescription!.sdp;
    await audio.sender.replaceTrack(sources[1].stream.getAudioTracks()[0]);
    await expect.poll(async () => {
      const observation = await pion.rtp();
      expect(observation.errors).toEqual([]);
      return observation.application.length > before.application.length + 25 &&
        observation.inbound.slice(before.inbound.length).filter(packet => packet.payloadType === 63).length > 5;
    }, { timeout: 15_000 }).toBe(true);
    const observation = await pion.rtp();
    const streams = verifyIncoming(observation, activeAudioCodecs(browser.localDescription));
    expect(Array.from(streams.keys()), "replacement preserves the negotiated stream").toEqual([ssrc]);
    expect(audio.sender.track).toBe(sources[1].stream.getAudioTracks()[0]);
    expect(browser.localDescription!.sdp, "replaceTrack does not require negotiation").toBe(description);
    const fresh = observation.application.slice(before.application.length);
    expect(fresh.map(packet => packet.payload), "replacement produces different Opus bytes")
      .not.toEqual(before.application.slice(-fresh.length).map(packet => packet.payload));
    console.log(`[RED browser replacement] same SSRC=${ssrc}, fresh exact Opus packets=${fresh.length}`);
  } finally {
    await Promise.all(sources.map(source => source.close()));
  }
});

test("Opus RED bundled audio video and data survive renegotiation and ICE restart", async ({ interop, skip }) => {
  await requireRED(interop, skip, "Send", "Receive");
  for (let cycle = 0; cycle < 2; cycle++) {
    const source = await oscillatorSource(440);
    const videoSource = await mediaSource("video");
    const browser = interop.browserPeer();
    const playback = await audioSink(browser);
    const video = document.createElement("video");
    video.autoplay = video.playsInline = video.muted = true;
    document.body.append(video);
    browser.addEventListener("track", ({ track }) => {
      if (track.kind === "video") video.srcObject = new MediaStream([track]);
    });
    let pion: PionPeer | undefined;
    try {
      const audio = browser.addTransceiver(source.stream.getAudioTracks()[0], { direction: "sendrecv", streams: [source.stream] });
      preferAudioCodecs(audio, "send");
      const camera = browser.addTransceiver(videoSource.stream.getVideoTracks()[0], { direction: "sendrecv", streams: [videoSource.stream] });
      camera.setCodecPreferences(RTCRtpReceiver.getCapabilities("video")!.codecs.filter(codec => codec.mimeType.toLowerCase() === "video/vp8"));
      const channel = browser.createDataChannel("red-lifecycle");
      let opens = 0, closes = 0;
      channel.addEventListener("open", () => opens++);
      channel.addEventListener("close", () => closes++);
      pion = await interop.pionPeer({ behavior: "red-bundled-echo", opusRED: true, observationLimit: 2048 });
      await interop.negotiate(browser, pion);
      await interop.waitForOpen(channel);
      const sctp = browser.sctp;
      expect(audio.sender.transport).toBe(camera.sender.transport);
      expect(audio.sender.transport).toBe(sctp!.transport);
      const fingerprint = browser.localDescription!.sdp.match(/^a=fingerprint:(.+)/m)![1].trim();
      const frames = async () => Array.from((await browser.getStats()).values()).find(stat => stat.type === "inbound-rtp" && stat.kind === "video")?.framesDecoded ?? 0;
      let checkpoint = { inbound: 0, outbound: 0, application: 0, samples: 0, frames: 0 };
      const progress = async (phase: string) => {
        await expect.poll(async () => {
          const observations = await pion!.rtp();
          expect(observations.errors).toEqual([]);
          const freshInbound = observations.inbound.slice(checkpoint.inbound);
          const freshOutbound = observations.outbound.slice(checkpoint.outbound);
          return observations.application.length > checkpoint.application + 10 &&
            freshInbound.filter(packet => packet.payloadType === 63).length > 5 &&
            freshOutbound.filter(packet => packet.payloadType === 63).length > 5;
        }, { timeout: 15_000 }).toBe(true);
        await expect.poll(async () => samples((await audioStats(browser))[0]), { timeout: 15_000 }).toBeGreaterThan(checkpoint.samples + 4800);
        await expect.poll(playback.rms, { timeout: 15_000 }).toBeGreaterThan(0.01);
        await expect.poll(frames, { timeout: 15_000 }).toBeGreaterThan(checkpoint.frames + 2);
        const reply = interop.nextMessage(channel);
        const message = `RED lifecycle ${cycle}/${phase}`;
        channel.send(message);
        expect(await reply).toBe(message);
        const observation = await pion!.rtp();
        checkpoint = { inbound: observation.inbound.length, outbound: observation.outbound.length,
          application: observation.application.length, samples: samples((await audioStats(browser))[0]), frames: await frames() };
      };
      await progress("initial");
      const origin = browser.localDescription!.sdp.match(/^o=(.+)/m)![1].trim();
      await interop.negotiate(browser, pion);
      expect(browser.localDescription!.sdp.match(/^o=(.+)/m)![1].trim()).not.toBe(origin);
      audioCodecs(browser.localDescription);
      audioCodecs(browser.remoteDescription);
      await progress("RED renegotiation");
      const before = browser.localDescription!.sdp.match(/^a=ice-ufrag:(.+)/m)![1].trim();
      await interop.negotiate(browser, pion, { iceRestart: true });
      expect(browser.localDescription!.sdp.match(/^a=ice-ufrag:(.+)/m)![1].trim()).not.toBe(before);
      expect(browser.localDescription!.sdp.match(/^a=fingerprint:(.+)/m)![1].trim()).toBe(fingerprint);
      expect(browser.sctp).toBe(sctp);
      await progress("ICE restart");
      expect(channel.readyState).toBe("open");
      expect(opens).toBe(1); expect(closes).toBe(0);
      expect((await pion.snapshot()).signalingState).toBe("stable");
      const observations = await pion.rtp();
      verifyIncoming(observations, activeAudioCodecs(browser.localDescription), true);
      const codecs = audioCodecs(browser.remoteDescription);
      const outgoingSSRC = observations.outbound.find(packet => packet.payload !== "")!.ssrc;
      const echoedSource = observations.application.map(packet => ({ ...content(packet), ssrc: outgoingSSRC, payloadType: codecs.opus }));
      wireLedger(observations.outbound, codecs, { source: echoedSource });
      console.log(`[RED bundled lifecycle ${cycle}] fresh RED/Opus, video and data passed renegotiation and ICE restart`);
    } finally {
      await playback.close();
      video.pause(); video.srcObject = null; video.remove();
      await Promise.all([source.close(), videoSource.close()]);
      browser.close();
      // Keep the peer's bounded packet ledger available for fixture failure
      // diagnostics; fixture teardown performs the final DELETE afterwards.
      if (pion) await pion.closeMedia();
      expect(browser.signalingState).toBe("closed");
    }
  }
});

test("Opus RED discovers a new SSRC after removing and adding a stream", async ({ interop, skip }) => {
  await requireRED(interop, skip, "Send");
  const browser = interop.browserPeer();
  const sources = await Promise.all([oscillatorSource(440), oscillatorSource(880), oscillatorSource(660)]);
  try {
    let audio = browser.addTransceiver(sources[0].stream.getAudioTracks()[0], { direction: "sendonly", streams: [sources[0].stream] });
    preferAudioCodecs(audio, "send");
    const pion = await interop.pionPeer({ behavior: "red-audio-receive", opusRED: true, observationLimit: 2048 });
    await interop.negotiate(browser, pion);
    const observed = new Set<number>();
    for (let generation = 0; generation < 3; generation++) {
      if (generation > 0) {
        browser.removeTrack(audio.sender);
        // Preserve the inactive m-line and its bundled transport. Stopping the
        // last transceiver instead tears down DTLS before a new stream is added.
        await interop.negotiate(browser, pion);
        audio = browser.addTransceiver(sources[generation].stream.getAudioTracks()[0], { direction: "sendonly", streams: [sources[generation].stream] });
        preferAudioCodecs(audio, "send");
        await interop.negotiate(browser, pion);
      }
      let newSSRC = 0;
      await expect.poll(async () => {
        const observation = await pion.rtp();
        expect(observation.errors).toEqual([]);
        const current = Array.from(groups(observation.application)).find(([ssrc, packets]) => !observed.has(ssrc) && packets.length > 25);
        newSSRC = current?.[0] ?? 0;
        return newSSRC !== 0;
      }, { timeout: 15_000 }).toBe(true);
      observed.add(newSSRC);
      expect((await pion.snapshot()).signalingState).toBe("stable");
    }
    const observations = await pion.rtp();
    const streams = verifyIncoming(observations, activeAudioCodecs(browser.localDescription));
    expect(streams.size).toBe(3);
    console.log(`[RED stream rebind] three distinct SSRCs=${Array.from(observed)}, exact independent Opus deliveries=${observations.application.length}`);
  } finally {
    await Promise.all(sources.map(source => source.close()));
  }
});

test("Opus RED Pion sender replacement preserves the audio stream", async ({ interop, skip }) => {
  await requireRED(interop, skip, "Receive");
  const browser = interop.browserPeer();
  const playback = await audioSink(browser);
  try {
    preferAudioCodecs(browser.addTransceiver("audio", { direction: "recvonly" }), "receive");
    const pion = await interop.pionPeer({ behavior: "red-audio-send", opusRED: true,
      observationLimit: 2048, redSource: { packets: 1024 } });
    await interop.negotiate(browser, pion);
    await expect.poll(async () => (await pion.rtp()).source.length, { timeout: 15_000 }).toBeGreaterThan(25);
    const before = await pion.rtp();
    const decoded = samples((await audioStats(browser))[0]);
    await pion.replaceAudioTrack();
    await expect.poll(async () => {
      const observation = await pion.rtp();
      expect(observation.errors).toEqual([]);
      return observation.source.length > before.source.length + 25 &&
        observation.outbound.slice(before.outbound.length).filter(packet => packet.payloadType === 63).length > 5;
    }, { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => samples((await audioStats(browser))[0]), { timeout: 15_000 }).toBeGreaterThan(decoded + 4800);
    await expect.poll(playback.rms, { timeout: 15_000 }).toBeGreaterThan(0.01);
    const observation = await pion.rtp();
    const codecs = audioCodecs(browser.remoteDescription);
    const ledger = wireLedger(observation.outbound, codecs, { source: observation.source });
    expect(groups(observation.source).size, "replacement keeps the negotiated SSRC").toBe(1);
    expect(observation.source[0].ssrc).toBe(before.source[0].ssrc);
    expect(Array.from(ledger.primary.values())).toEqual(observation.source.slice(0, ledger.primary.size).map(content));
    expect(observation.errors).toEqual([]); expect(observation.truncated).toBe(false);
    console.log(`[RED Pion replacement] same SSRC=${observation.source[0].ssrc}, exact source/wire packets=${ledger.primary.size}, fresh decoded audio`);
  } finally {
    await playback.close();
  }
});

test("Opus RED repeated teardown drains media readers and writers", async ({ interop, skip }) => {
  await requireRED(interop, skip);
  for (let cycle = 0; cycle < 3; cycle++) {
    const sender = await interop.pionPeer({ behavior: "red-audio-send", opusRED: true,
      redSource: { packets: 1024 }, audioCodecOrder: "red-first", observationLimit: 2048 });
    const receiver = await interop.pionPeer({ behavior: "red-audio-receive", opusRED: true,
      redSource: { packets: 1024 }, audioCodecOrder: "red-first", observationLimit: 2048 });
    await interop.negotiate(sender, receiver);
    await expect.poll(async () => {
      const sent = await sender.rtp();
      const received = await receiver.rtp();
      expect(sent.errors).toEqual([]);
      expect(received.errors).toEqual([]);
      return sent.activeMediaWriters > 0 && received.activeMediaReaders > 0 && received.application.length > 25;
    }, { timeout: 15_000 }).toBe(true);
    // closeMedia leaves observations readable so zero readers/writers is proved
    // directly. DELETE then verifies the ordinary fixture's idempotent removal.
    const closed = await Promise.all([sender.closeMedia(), receiver.closeMedia()]);
    for (const observation of closed) {
      expect(observation.activeMediaReaders).toBe(0);
      expect(observation.activeMediaWriters).toBe(0);
      expect(observation.errors).toEqual([]);
    }
    for (const pion of [sender, receiver]) {
      expect((await pion.snapshot()).connectionState).toBe("closed");
      await pion.close();
      await expect(pion.snapshot()).rejects.toThrow("404");
      await pion.close();
    }
    console.log(`[RED teardown ${cycle}] connected media stopped; active readers=0, writers=0; removal idempotent`);
  }
});
