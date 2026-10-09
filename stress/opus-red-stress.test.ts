/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { test, expect, type REDSourceOptions } from "../test/fixtures/interop";
import { audioCodecs, content, identity, requireRED, wireLedger } from "../test/fixtures/opus-red";
import { assertRecovery, expectedDeliveries, recoveryScenario } from "../test/fixtures/red-recovery";

const repeats = 20;
const observationPrefixLimit = 512;

const client = navigator as Navigator & { userAgentData?: {
  getHighEntropyValues(hints: string[]): Promise<{ fullVersionList?: { brand: string; version: string }[] }>;
} };
const versions = await client.userAgentData?.getHighEntropyValues(["fullVersionList"]).catch(() => undefined);
console.log(`[Opus RED stress] browser=${navigator.userAgent}; versions=${versions?.fullVersionList?.map(value => `${value.brand}/${value.version}`).join(", ") ?? "unavailable"}`);

// Blocks are separated by clean carriers so every declared missing packet has
// a surviving copy. A late or duplicate carrier is injected after decryption.
function mixedCampaign(seed: number) {
  let state = seed;
  const random = () => { state = Math.imul(state, 1664525) + 1013904223 >>> 0; return state; };
  const dropped: number[] = [], delayed: number[] = [], duplicated: number[] = [0];
  for (let block = 4; block < 248; block += 8) {
    const action = (random() >>> 28) % 4;
    if (action === 0 || action === 1) dropped.push(block + 1);
    if (action === 1) dropped.push(block + 2);
    if (action === 2) delayed.push(block + 2);
    if (random() >>> 28 & 1) duplicated.push(block + 6);
  }
  const order = Array.from({ length: 258 }, (_, index) => index).filter(index => !dropped.includes(index));
  for (const index of delayed) {
    order.splice(order.indexOf(index), 1);
    order.splice(order.indexOf(index + 1) + 1, 0, index);
  }
  return { dropped, delayed, duplicated, order: order.flatMap(index => duplicated.includes(index) ? [index, index] : [index]) };
}

for (const profile of [
  { name: "isolated carrier loss", dropped: [37] },
  { name: "initial carrier loss", dropped: [0] },
  { name: "two consecutive carrier losses", dropped: [37, 38] },
]) {
  for (let iteration = 1; iteration <= repeats; iteration++) {
    test(`Opus RED stress: ${profile.name} (iteration ${iteration}/${repeats})`, { retry: 0 }, async ({ interop, skip }) => {
      skip(import.meta.env.VITE_OPUS_RED_STRESS !== "1", "Set VITE_OPUS_RED_STRESS=1 to run fresh-peer recovery repetitions");
      await requireRED(interop, skip);
      const { sent, received, codecs } = await recoveryScenario(interop, { sender: { outboundDrop: profile.dropped } });
      expect(sent.droppedOutbound.map(identity), "exact configured missing carrier identities")
        .toEqual(profile.dropped.map(index => identity(sent.source[index])));
      assertRecovery(sent, received, codecs);
    });
  }
}

for (let iteration = 0; iteration < repeats; iteration++) {
  const seed = (0x2198ae5 + Math.imul(iteration, 0x9e3779b9)) >>> 0;
  test(`Opus RED stress: seeded loss, delay, and duplicates (seed ${seed})`, { retry: 0 }, async ({ interop, skip }) => {
    skip(import.meta.env.VITE_OPUS_RED_STRESS !== "1", "Set VITE_OPUS_RED_STRESS=1 to run seeded fresh-peer campaigns");
    await requireRED(interop, skip);
    const campaign = mixedCampaign(seed);
    expect(campaign.dropped.length, "seed exercises loss").toBeGreaterThan(0);
    expect(campaign.delayed.length, "seed exercises delay").toBeGreaterThan(0);
    expect(campaign.duplicated.length, "seed exercises duplicates beyond startup").toBeGreaterThan(1);
    const { sent, received, codecs } = await recoveryScenario(interop, {
      sender: { outboundDrop: campaign.dropped }, receiver: { inboundOrder: campaign.order },
    });
    expect(sent.droppedOutbound.map(identity), "exact source losses")
      .toEqual(campaign.dropped.map(index => identity(sent.source[index])));
    wireLedger(sent.outbound, codecs, { source: sent.source });
    const byIdentity = new Map(sent.outbound.map(packet => [identity(packet), packet]));
    const carriers = campaign.order.map(index => {
      const packet = byIdentity.get(identity(sent.source[index]));
      expect(packet, `configured source carrier ${index}`).toBeDefined();
      return packet!;
    });
    carriers.push(sent.outbound.at(-1)!);
    expect(received.inboundOriginal, "transport delivered every surviving original unchanged").toEqual(sent.outbound);
    expect(received.inbound, "declared decrypted carrier order and duplicates").toEqual(carriers);
    expect(received.inboundActions.filter(action => action.kind === "release" || action.kind === "duplicate").map(action => action.ordinal))
      .toEqual(campaign.order);
    const expected = expectedDeliveries(sent.source, carriers, codecs);
    expect(received.application.map(content), "independent decoder predicts every delivery identity, bytes, and per-carrier order")
      .toEqual(expected);
    const ids = received.application.map(identity);
    expect(new Set(ids).size, "no duplicate application delivery").toBe(ids.length);
    expect([...ids].sort(), "all 256 media packets and two trailers are recoverable").toEqual(sent.source.map(identity).sort());
    console.log(`[Opus RED stress] seed=${seed}, losses=${campaign.dropped.length}, delays=${campaign.delayed.length}, ` +
      `duplicates=${campaign.duplicated.length}, exact deliveries=${ids.length}`);
  });
}

test("Opus RED stress: 70,000 packets across RTP sequence and timestamp wrap", { timeout: 180_000, retry: 0 },
  async ({ interop, skip }) => {
    skip(import.meta.env.VITE_OPUS_RED_STRESS !== "1", "Set VITE_OPUS_RED_STRESS=1 to run the accelerated 70,000-packet stream");
    await requireRED(interop, skip);
    const source: REDSourceOptions = {
      packets: 70_000, trailers: 2, sequenceStart: 65_500, timestampStart: 0xffff8000, intervalMs: 1, stream: true,
    };
    const mediaCount = source.packets! + source.trailers!;
    const sequence = (index: number) => (source.sequenceStart! + index) & 0xffff;
    const timestamp = (index: number) => (source.timestampStart! + index * 960) >>> 0;
    const common = { opusRED: true, redSource: source, observationLimit: observationPrefixLimit, audioCodecOrder: "red-first" as const };
    const sender = await interop.pionPeer({ ...common, behavior: "red-audio-send" });
    const receiver = await interop.pionPeer({ ...common, behavior: "red-audio-receive" });
    await interop.negotiate(sender, receiver);
    const [senderSnapshot, receiverSnapshot] = await Promise.all([sender.snapshot(), receiver.snapshot()]);
    const codecs = audioCodecs(senderSnapshot.localDescription);
    console.log(`[Opus RED stress] sender SDP:\n${senderSnapshot.localDescription?.sdp}`);
    console.log(`[Opus RED stress] receiver SDP:\n${receiverSnapshot.localDescription?.sdp}`);
    const started = performance.now();
    let nextProgressAt = started + 15_000;
    await expect.poll(async () => {
      const [sent, received] = await Promise.all([sender.rtp(), receiver.rtp()]);
      expect(sent.errors, "source transport errors during the accelerated stream").toEqual([]);
      expect(received.errors, "receiver transport/decoding errors during the accelerated stream").toEqual([]);
      if (performance.now() >= nextProgressAt) {
        console.log(`[Opus RED stress] elapsed=${Math.floor((performance.now() - started) / 1000)}s, ` +
          `source packets=${sent.totals.source}, Opus deliveries=${received.totals.application}, ` +
          `retained prefix=${sent.source.length}/${received.application.length}`);
        nextProgressAt = performance.now() + 15_000;
      }
      return sent.sourceDone && received.drained;
    }, { timeout: 150_000, interval: 500 }).toBe(true);
    const [sent, received] = await Promise.all([sender.rtp(), receiver.rtp()]);
    expect(sent.errors, "no final source transport errors").toEqual([]);
    expect(received.errors, "no final receiver transport/decoding errors").toEqual([]);
    expect(sent.sourceDone, "the complete controlled source was transmitted").toBe(true);
    expect(received.drained, "the exact final padding sentinel drained prior RED outputs").toBe(true);
    expect(sent.totals.source, "all media plus the two recovery trailers were emitted").toBe(mediaCount);
    expect(sent.totals.outbound, "every encoded media carrier plus the empty completion sentinel was transmitted").toBe(mediaCount + 1);
    expect(received.totals.inbound, "every carrier arrived through the complete peer pipeline").toBe(mediaCount + 1);
    expect(received.totals.application, "all media was delivered as Opus").toBe(mediaCount);
    expect(sent.totals.outboundRED, "RED remained active across both sequence wraps").toBe(mediaCount - 1);
    expect(received.totals.inboundRED, "the receiver observed all RED carriers across both sequence wraps").toBe(mediaCount - 1);
    expect(sent.droppedOutbound, "this stream has no configured carrier loss").toEqual([]);
    expect(sent.source, "source evidence retains only a bounded prefix").toHaveLength(observationPrefixLimit);
    for (const observations of [sent, received]) {
      expect(observations.truncated, "long-stream evidence exceeded the retained prefix").toBe(true);
      for (const direction of ["source", "outbound", "inbound", "application", "droppedOutbound"] as const) {
        expect(observations[direction].length, `${direction} evidence remains bounded`).toBeLessThanOrEqual(observationPrefixLimit);
      }
    }
    sent.source.forEach((packet, index) => {
      expect(packet.sequenceNumber, "controlled source sequence progression").toBe(sequence(index));
      expect(packet.timestamp, "controlled source timestamp progression").toBe(timestamp(index));
    });
    expect(sent.source[36].sequenceNumber, "wire prefix crosses the initial 16-bit sequence wrap").toBe(0);
    expect(sent.source[35].timestamp, "wire prefix crosses the initial 32-bit timestamp wrap").toBeLessThan(sent.source[34].timestamp);
    const outbound = wireLedger(sent.outbound, codecs, { source: sent.source });
    const inbound = wireLedger(received.inbound, codecs, { source: sent.source });
    expect(outbound.primary.size).toBe(observationPrefixLimit);
    expect(inbound.primary.size).toBe(observationPrefixLimit);
    expect(sent.outbound[0].payloadType, "ordinary Opus startup is preserved").toBe(codecs.opus);
    expect(outbound.depths, "one-copy RED startup").toContain(1);
    expect(outbound.depths, "two-copy RED history").toContain(2);
    expect(Math.max(...outbound.depths), "RED history remains at two copies").toBe(2);
    expect(received.application.map(content), "exact ordered Opus deliveries in the retained prefix").toEqual(sent.source.map(content));

    const sourceSummaries = sent.summaries.source;
    const applicationSummaries = received.summaries.application;
    const streamIDs = Object.keys(sourceSummaries);
    expect(streamIDs, "one controlled source SSRC").toHaveLength(1);
    expect(Object.keys(applicationSummaries), "receiver summarizes the same source SSRC").toEqual(streamIDs);
    for (const ssrc of streamIDs) {
      const original = sourceSummaries[ssrc], delivered = applicationSummaries[ssrc];
      expect(original.count, "complete source media count across a full sequence cycle").toBe(mediaCount);
      expect(delivered.count, "no missing or duplicate application deliveries").toBe(mediaCount);
      expect(original.sha256, "ordered source digest is SHA256").toMatch(/^[0-9a-f]{64}$/);
      expect(delivered.sha256, "all ordered normalized Opus headers and payloads match").toBe(original.sha256);
      for (const summary of [original, delivered]) {
        expect(summary.lastSequenceNumber, "ending sequence proves progression beyond the second sequence wrap").toBe(sequence(mediaCount - 1));
        expect(summary.lastTimestamp, "ending timestamp matches the complete source").toBe(timestamp(mediaCount - 1));
      }
    }
    console.log(`[Opus RED stress] complete media=${mediaCount}, source/app SHA256 matched, ` +
      `final sequence=${sequence(mediaCount - 1)}, final timestamp=${timestamp(mediaCount - 1)}, ` +
      `verified prefix=${observationPrefixLimit}, elapsed=${Math.floor((performance.now() - started) / 1000)}s`);
  });
