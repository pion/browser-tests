/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { expect, type Interop, type ObservedRTP, type REDImpairmentOptions, type REDSourceOptions, type RTPObservations } from "./interop";
import { audioCodecs, content, decodeRED, identity, wireLedger, type Codecs } from "./opus-red";

export async function recoveryScenario(interop: Interop, options: {
  source?: REDSourceOptions; sender?: REDImpairmentOptions; receiver?: REDImpairmentOptions;
  maxPacketSize?: number;
} = {}) {
  const redSource = { packets: 256, trailers: 2, intervalMs: 2, ...options.source };
  const common = { opusRED: true, redSource, observationLimit: 512, audioCodecOrder: "red-first" as const };
  const sender = await interop.pionPeer({ ...common, behavior: "red-audio-send", redImpairment: options.sender, redMaxPacketSize: options.maxPacketSize });
  const receiver = await interop.pionPeer({ ...common, behavior: "red-audio-receive", redImpairment: options.receiver });
  await interop.negotiate(sender, receiver);
  const description = (await sender.snapshot()).localDescription;
  const codecs = audioCodecs(description);
  const audio = description!.sdp!.split(/(?=^m=)/m).find(section => section.startsWith("m=audio "))!;
  expect(audio, "Opus FEC is disabled for recovery attribution").toMatch(/useinbandfec=0/);
  expect(audio, "no competing audio NACK or RTX").not.toMatch(/^a=rtcp-fb:\d+ nack|^a=rtpmap:\d+ rtx\//mi);
  await expect.poll(async () => {
    const sent = await sender.rtp(), received = await receiver.rtp();
    expect(sent.errors, "source transport errors").toEqual([]);
    expect(received.errors, "receiver transport/decoding errors").toEqual([]);
    return sent.sourceDone && received.drained;
  }, { timeout: 15_000 }).toBe(true);
  const sent = await sender.rtp(), received = await receiver.rtp();
  expect(sent.truncated, "complete finite source/wire ledger").toBe(false);
  expect(received.truncated, "complete finite receive/delivery ledger").toBe(false);
  expect(sent.source).toHaveLength(redSource.packets + redSource.trailers);
  expect(sent.outbound.at(-1), "completion carries no audio/redundancy").toMatchObject({ padding: true, paddingSize: 1, payload: "" });
  return { sender, receiver, sent, received, codecs };
}

// Source identities are authoritative; RFC2198 copies are resolved by timestamp
// and bytes, not by assuming an unseen packet's sequence number.
export function expectedDeliveries(source: ObservedRTP[], carriers: ObservedRTP[], codecs: Codecs,
  malformedSequences: number[] = []) {
  const known = new Map(source.map(packet => [identity(packet), content(packet)]));
  const positions = new Map<string, number>();
  let previous = source[0]?.sequenceNumber ?? 0, extended = previous;
  source.forEach((packet, index) => {
    if (index) extended += (packet.sequenceNumber - previous + 0x8000 & 0xffff) - 0x8000;
    previous = packet.sequenceNumber;
    positions.set(identity(packet), extended);
  });
  const output: ObservedRTP[] = [], delivered = new Set<number>(), padding = new Set<number>();
  let highest: number | undefined;
  for (const carrier of carriers) {
    if (carrier.padding && carrier.payload === "") {
      const position = highest === undefined ? carrier.sequenceNumber : highest +
        ((carrier.sequenceNumber - (highest & 0xffff) + 0x8000 & 0xffff) - 0x8000);
      if (highest !== undefined && highest - position >= 64) continue;
      if (highest !== undefined && position - highest >= 64) {
        delivered.clear();
        padding.clear();
      }
      padding.add(position);
      delivered.add(position);
      highest = Math.max(highest ?? position, position);
      continue;
    }
    if (malformedSequences.includes(carrier.sequenceNumber)) continue;
    const primarySource = known.get(identity(carrier));
    expect(primarySource, "carrier identity belongs to the controlled source").toBeDefined();
    const position = positions.get(identity(carrier))!;
    if (highest !== undefined && highest - position >= 64) continue;
    if (highest !== undefined && position - highest >= 64) {
      delivered.clear();
      padding.clear();
    }
    const reference = Math.max(highest ?? position, position);
    const decoded = carrier.payloadType === codecs.red ? decodeRED(carrier.payload) : {
      redundant: [], primary: { payloadType: carrier.payloadType, payload: carrier.payload, offset: 0 },
    };
    expect(decoded.primary.payloadType).toBe(codecs.opus);
    expect(decoded.primary.payload).toBe(primarySource!.payload);
    for (const block of decoded.redundant) {
      expect(block.payloadType).toBe(codecs.opus);
      const timestamp = (carrier.timestamp - block.offset) >>> 0;
      const candidates = source.filter(packet => packet.ssrc === carrier.ssrc && packet.timestamp === timestamp && packet.payload === block.payload);
      expect(candidates, "copy has exactly one independent source identity").toHaveLength(1);
      const copy = content(candidates[0]), copyPosition = positions.get(identity(copy))!;
      if (block.offset === 0 || !block.payload || reference - copyPosition >= 64 ||
          Array.from(padding).some(sequence => sequence >= copyPosition && sequence < position)) continue;
      if (!delivered.has(copyPosition)) { output.push(copy); delivered.add(copyPosition); }
    }
    if (!delivered.has(position)) { output.push(primarySource!); delivered.add(position); }
    highest = reference;
  }
  return output;
}

export function assertRecovery(sent: RTPObservations, received: RTPObservations, codecs: Codecs,
  options: { missing?: number[]; malformedSequences?: number[] } = {}) {
  wireLedger(sent.outbound, codecs, { source: sent.source });
  expect(received.inbound, "all transmitted carriers arrived unchanged").toEqual(sent.outbound);
  for (const dropped of sent.droppedOutbound) {
    const original = sent.source.find(packet => identity(packet) === identity(dropped));
    expect(original, "dropped carrier belongs to the source").toBeDefined();
    const primary = dropped.payloadType === codecs.red ? decodeRED(dropped.payload).primary : dropped;
    expect(primary.payloadType).toBe(codecs.opus);
    expect(primary.payload).toBe(original!.payload);
    expect(sent.outbound.some(packet => identity(packet) === identity(dropped)), "dropped primary was not transmitted").toBe(false);
    expect(received.inbound.some(packet => identity(packet) === identity(dropped)), "dropped primary did not arrive").toBe(false);
  }
  const expected = expectedDeliveries(sent.source, received.inbound, codecs, options.malformedSequences);
  expect(received.application.map(content), "exact Opus output in each carrier's recovery order").toEqual(expected);
  const ids = received.application.map(identity);
  expect(new Set(ids).size, "no duplicate application output").toBe(ids.length);
  const wanted = sent.source.filter((_, index) => !(options.missing ?? []).includes(index)).map(identity).sort();
  expect([...ids].sort(), "exact recoverable source set; no invented packets").toEqual(wanted);
  expect(sent.errors).toEqual([]);
  expect(received.errors).toEqual([]);
  console.log(`[RED recovery] source=${sent.source.length}, surviving=${sent.outbound.filter(packet => packet.payload !== "").length}, ` +
    `dropped=${sent.droppedOutbound.length}, exact deliveries=${ids.length}, unavailable=${options.missing?.length ?? 0}, completion observed`);
}
