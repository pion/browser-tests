/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { test, expect, type Interop, type ObservedRTP } from "../fixtures/interop";
import { audioCodecs, content, decodeRED, identity, requireRED, wireLedger } from "../fixtures/opus-red";
import { assertRecovery, expectedDeliveries, recoveryScenario } from "../fixtures/red-recovery";

const total = 258;
const ordinals = () => Array.from({ length: total }, (_, index) => index);
const bytes64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
type Scenario = Awaited<ReturnType<typeof recoveryScenario>>;

function exactUnchanged(result: Scenario, excluded: number[] = []) {
  const { sent, received } = result;
  expect(received.inbound, "complete unchanged transmitted carrier stream").toEqual(sent.outbound);
  expect(received.application.map(content), "exact source bytes and order; padding-only media is excluded")
    .toEqual(sent.source.filter((_, index) => !excluded.includes(index)).map(content));
  const ids = received.application.map(identity);
  expect(new Set(ids).size).toBe(ids.length);
  expect(sent.errors).toEqual([]);
  expect(received.errors).toEqual([]);
}

for (const budget of [
  { size: 521, depth: 2 }, { size: 520, depth: 1 }, { size: 357, depth: 1 }, { size: 356, depth: 0 },
]) {
  test(`Opus RED includes CSRCs, extensions, and padding in the ${budget.size}-byte packet budget`, { retry: 0 }, async ({ interop, skip }) => {
    await requireRED(interop, skip);
    const csrc = [0x11223344, 0x55667788], extensions = [{ id: 7, payload: bytes64([0xaa, 0xbb]) }];
    const packetOverrides = ordinals().map(index => ({ index, csrc, extensions, paddingSize: 4 }));
    const result = await recoveryScenario(interop, { source: { packetOverrides }, maxPacketSize: budget.size });
    const { sent, codecs } = result;
    for (const packet of sent.source) expect(packet).toMatchObject({ csrc, extensions, padding: true, paddingSize: 4, headerSize: 28 });
    for (const packet of sent.outbound.filter(packet => packet.payload !== "")) {
      expect(packet).toMatchObject({ csrc, extensions, padding: true, paddingSize: 4, headerSize: 28 });
      const encodedBytes = atob(packet.payload).length;
      expect(packet.packetSize, "independent complete RTP accounting").toBe(28 + encodedBytes + 4);
      if (packet.payloadType === codecs.red) expect(packet.packetSize, "encoded RED fits the configured budget").toBeLessThanOrEqual(budget.size);
    }
    if (budget.depth === 0) {
      expect(sent.outbound.every(packet => packet.payloadType === codecs.opus), "plain Opus when no copy fits").toBe(true);
    } else {
      const ledger = wireLedger(sent.outbound, codecs, { source: sent.source });
      expect(Math.max(...ledger.depths)).toBe(budget.depth);
      const steady = sent.outbound.find(packet => identity(packet) === identity(sent.source[37]))!;
      const decoded = decodeRED(steady.payload);
      expect(decoded.redundant.map(block => block.payload), "newest copies fit first; the oldest is shed")
        .toEqual(sent.source.slice(37 - budget.depth, 37).map(packet => packet.payload));
    }
    exactUnchanged(result);
  });
}

test("Opus RED forwards a primary already larger than its configured packet budget unchanged", { retry: 0 }, async ({ interop, skip }) => {
  await requireRED(interop, skip);
  const csrc = [0x11223344, 0x55667788], extensions = [{ id: 7, payload: bytes64([0xaa, 0xbb]) }];
  const packetOverrides = ordinals().map(index => ({ index, csrc, extensions, paddingSize: 4 }));
  const result = await recoveryScenario(interop, { source: { packetOverrides }, maxPacketSize: 170 });
  const { sent, codecs } = result;
  for (const packet of sent.outbound.filter(packet => packet.payload !== "")) {
    expect(packet).toMatchObject({ payloadType: codecs.opus, headerSize: 28, packetSize: 192, csrc, extensions, padding: true, paddingSize: 4 });
  }
  exactUnchanged(result);
});

test("Opus RED preserves primary headers and CSRCs while removing unsupported recovered header metadata", { retry: 0 }, async ({ interop, skip }) => {
  await requireRED(interop, skip);
  const csrc = [0x11223344, 0x55667788], extensions = [{ id: 7, payload: bytes64([0xaa, 0xbb]) }];
  const packetOverrides = ordinals().map(index => ({ index, csrc, extensions, paddingSize: 4 }));
  const result = await recoveryScenario(interop, { source: { packetOverrides }, sender: { outboundDrop: [37] }, maxPacketSize: 521 });
  assertRecovery(result.sent, result.received, result.codecs);
  const recovered = result.received.application.find(packet => identity(packet) === identity(result.sent.source[37]))!;
  const primary = result.received.application.find(packet => identity(packet) === identity(result.sent.source[38]))!;
  expect(recovered.csrc, "CSRCs are known from the carrier and retained").toEqual(csrc);
  expect(recovered.extensions ?? [], "the original extension values are unavailable to RED recovery").toEqual([]);
  expect(recovered.padding ?? false, "the original padding flag is unavailable to RED recovery").toBe(false);
  expect(recovered.paddingSize ?? 0).toBe(0);
  expect(primary).toMatchObject({ csrc, extensions, padding: true, paddingSize: 4, headerSize: 28 });
});

for (const length of [1023, 1024]) {
  test(`Opus RED handles the ${length}-byte Opus block-length boundary`, { retry: 0 }, async ({ interop, skip }) => {
    await requireRED(interop, skip);
    const payload = bytes64(Array.from({ length }, (_, index) => index & 0xff));
    const result = await recoveryScenario(interop, { source: { packetOverrides: [{ index: 37, payload }] } });
    const { sent, received, codecs } = result;
    expect(sent.source[37].payload, "the source applied the exact declared payload length").toBe(payload);
    const at = (index: number) => sent.outbound.find(packet => identity(packet) === identity(sent.source[index]))!;
    if (length === 1023) {
      expect(at(37).packetSize, "the largest RFC2198 copy fits exactly with a 160-byte companion").toBe(1200);
      expect(decodeRED(at(38).payload).redundant.map(block => block.payload)).toEqual([payload]);
      expect(at(38).packetSize).toBe(1200);
    } else {
      expect(at(37).payloadType, "oversized blocks are forwarded without RED").toBe(codecs.opus);
      expect(at(37).payload).toBe(payload);
      expect(at(38).payloadType, "oversized audio clears unsafe sender history").toBe(codecs.opus);
      expect(decodeRED(at(39).payload).redundant.map(block => block.payload)).toEqual([sent.source[38].payload]);
    }
    wireLedger(sent.outbound, codecs, { source: sent.source });
    expect(received.application.find(packet => identity(packet) === identity(sent.source[37]))!.payload).toBe(payload);
    exactUnchanged(result);
  });
}

test("Opus RED forwards empty nonpadding Opus and resets sender copy history", { retry: 0 }, async ({ interop, skip }) => {
  await requireRED(interop, skip);
  const result = await recoveryScenario(interop, { source: { packetOverrides: [{ index: 37, payload: "" }] } });
  const at = (index: number) => result.sent.outbound.find(packet => identity(packet) === identity(result.sent.source[index]))!;
  expect(at(37)).toMatchObject({ payloadType: result.codecs.opus, payload: "" });
  expect(at(37).padding ?? false).toBe(false);
  expect(at(38).payloadType).toBe(result.codecs.opus);
  expect(decodeRED(at(39).payload).redundant.map(block => block.payload)).toEqual([result.sent.source[38].payload]);
  exactUnchanged(result);
});

test("Opus RED consumes padding-only RTP without inventing audio across the padding sequence", { retry: 0 }, async ({ interop, skip }) => {
  await requireRED(interop, skip);
  const result = await recoveryScenario(interop, { source: { packetOverrides: [{ index: 37, payload: "", paddingSize: 4 }] } });
  const padding = result.received.inbound.find(packet => identity(packet) === identity(result.sent.source[37]))!;
  expect(padding).toMatchObject({ padding: true, paddingSize: 4, payload: "" });
  wireLedger(result.sent.outbound, result.codecs, { source: result.sent.source });
  expect(result.received.application.some(packet => identity(packet) === identity(padding)), "padding produces no application audio").toBe(false);
  exactUnchanged(result, [37]);
});

for (const offset of [16383, 16384]) {
  test(`Opus RED honors the ${offset}-tick timestamp-offset boundary`, { retry: 0 }, async ({ interop, skip }) => {
    await requireRED(interop, skip);
    const packetOverrides = ordinals().filter(index => index >= 64).map(index => ({ index, timestamp: 48000 + 63 * 960 + offset + (index - 64) * 960 }));
    const result = await recoveryScenario(interop, { source: { packetOverrides } });
    for (const { index, timestamp } of packetOverrides) expect(result.sent.source[index].timestamp).toBe(timestamp);
    const first = result.sent.outbound.find(packet => identity(packet) === identity(result.sent.source[64]))!;
    if (offset === 16383) {
      expect(decodeRED(first.payload).redundant).toEqual([{ payloadType: result.codecs.opus, offset, payload: result.sent.source[63].payload }]);
    } else {
      expect(first.payloadType, "an offset above 14 bits clears RED history").toBe(result.codecs.opus);
    }
    exactUnchanged(result);
  });
}

test("Opus RED recovers loss across simultaneous sequence and timestamp wrap", { retry: 0 }, async ({ interop, skip }) => {
  await requireRED(interop, skip);
  const result = await recoveryScenario(interop, { source: { sequenceStart: 65534, timestampStart: 0xfffff880 }, sender: { outboundDrop: [0, 1] } });
  expect(result.sent.source.slice(0, 4).map(packet => packet.sequenceNumber)).toEqual([65534, 65535, 0, 1]);
  expect(result.sent.source.slice(0, 4).map(packet => packet.timestamp)).toEqual([0xfffff880, 0xfffffc40, 0, 960]);
  assertRecovery(result.sent, result.received, result.codecs);
});

for (const distance of [63, 64]) {
  test(`Opus RED ${distance === 63 ? "delivers" : "rejects"} an unseen carrier ${distance} positions behind the receive window`, { retry: 0 }, async ({ interop, skip }) => {
    await requireRED(interop, skip);
    const dropped = [38, 39], delayed = 37, newest = delayed + distance;
    const order = ordinals().filter(index => !dropped.includes(index) && index !== delayed);
    order.splice(order.indexOf(newest) + 1, 0, delayed);
    const { sent, received, codecs } = await recoveryScenario(interop, { sender: { outboundDrop: dropped }, receiver: { inboundOrder: order } });
    expect(sent.droppedOutbound.map(identity)).toEqual(dropped.map(index => identity(sent.source[index])));
    const byID = new Map(sent.outbound.map(packet => [identity(packet), packet]));
    const expectedCarriers = [...order.map(index => byID.get(identity(sent.source[index]))!), sent.outbound.at(-1)!];
    expect(received.inboundOriginal, "the original network carriers arrived before replay").toEqual(sent.outbound);
    expect(received.inbound, "the delayed carrier is actually delivered after the declared window distance").toEqual(expectedCarriers);
    expect(received.inboundActions.filter(action => action.kind === "hold").map(action => action.ordinal))
      .toEqual(ordinals().filter(index => !dropped.includes(index)));
    expect(received.inboundActions.filter(action => action.kind === "release").map(action => action.ordinal)).toEqual(order);
    expect(received.inboundActions.filter(action => action.kind === "drop" || action.kind === "duplicate")).toEqual([]);
    const expected = expectedDeliveries(sent.source, expectedCarriers, codecs);
    expect(received.application.map(content)).toEqual(expected);
    expect(received.application.some(packet => identity(packet) === identity(sent.source[delayed]))).toBe(distance === 63);
    const wanted = sent.source.filter((_, index) => distance === 63 || index !== delayed).map(identity).sort();
    const delivered = received.application.map(identity);
    expect([...delivered].sort(), "exact window-dependent source set").toEqual(wanted);
    expect(new Set(delivered).size).toBe(delivered.length);
    expect(sent.errors).toEqual([]);
    expect(received.errors).toEqual([]);
  });
}

for (const jump of [63, 64]) {
  test(`Opus RED handles a ${jump}-position forward jump without inventing missing audio`, { retry: 0 }, async ({ interop, skip }) => {
    await requireRED(interop, skip);
    const order = [0, jump, 0, ...ordinals().filter(index => index > jump)];
    const { sent, received, codecs } = await recoveryScenario(interop, { receiver: { inboundOrder: order } });
    expect(sent.droppedOutbound, "the gap is introduced only after authentication").toEqual([]);
    expect(received.inboundOriginal, "all network originals arrived intact before the forward jump").toEqual(sent.outbound);
    const byID = new Map(sent.outbound.map(packet => [identity(packet), packet]));
    const expectedCarriers = [...order.map(index => byID.get(identity(sent.source[index]))!), sent.outbound.at(-1)!];
    expect(received.inbound, "the declared forward jump and late duplicate actually occurred").toEqual(expectedCarriers);
    expect(received.inboundActions.filter(action => action.kind === "hold").map(action => action.ordinal)).toEqual(ordinals());
    expect(received.inboundActions.filter(action => action.kind === "drop").map(action => action.ordinal))
      .toEqual(ordinals().filter(index => index > 0 && index < jump));
    expect(received.inboundActions.filter(action => action.kind === "release" || action.kind === "duplicate").map(action => action.ordinal)).toEqual(order);
    expect(received.inboundActions.filter(action => action.kind === "duplicate").map(action => action.ordinal)).toEqual([0]);
    const expected = expectedDeliveries(sent.source, expectedCarriers, codecs);
    expect(received.application.map(content), "exact window-reset output from original copies and primaries").toEqual(expected);
    const wanted = sent.source.filter((_, index) => index === 0 || index >= jump - 2).map(identity).sort();
    const delivered = received.application.map(identity);
    expect([...delivered].sort(), "only two predecessor copies bridge the otherwise unavailable forward gap").toEqual(wanted);
    expect(new Set(delivered).size, "late original startup never produces duplicate output").toBe(delivered.length);
    expect(sent.errors).toEqual([]);
    expect(received.errors).toEqual([]);
  });
}

async function malformedScenario(interop: Interop, payload: string, error: string) {
  const common = { opusRED: true, redSource: { packets: 256, trailers: 2, intervalMs: 2 }, observationLimit: 512,
    audioCodecOrder: "red-first" as const };
  const sender = await interop.pionPeer({ ...common, behavior: "red-audio-send" });
  const receiver = await interop.pionPeer({ ...common, behavior: "red-audio-receive",
    redImpairment: { inboundPayloads: [{ index: 37, payload, expectedError: error }] } });
  await interop.negotiate(sender, receiver);
  const codecs = audioCodecs((await sender.snapshot()).localDescription);
  expect(codecs.opus, "malformed payloads target the explicit default negotiated association").toBe(111);
  await expect.poll(async () => {
    const [sent, received] = await Promise.all([sender.rtp(), receiver.rtp()]);
    expect(sent.errors).toEqual([]);
    expect(received.errors, "no unrelated receiver transport/decoding errors").toEqual([]);
    expect(received.injectedErrors.length, "only the declared decoder failure is allowed").toBeLessThanOrEqual(1);
    if (received.injectedErrors.length) expect(received.injectedErrors[0]).toBe(error);
    return sent.sourceDone && received.drained;
  }, { timeout: 15_000 }).toBe(true);
  const [sent, received] = await Promise.all([sender.rtp(), receiver.rtp()]);
  expect(sent.truncated).toBe(false);
  expect(received.truncated).toBe(false);
  expect(sent.source).toHaveLength(total);
  expect(received.errors, "no unrelated final receiver errors").toEqual([]);
  expect(received.injectedErrors, "one explicit malformed RED rejection before continuing the same stream").toHaveLength(1);
  expect(received.injectedErrors[0]).toBe(error);
  expect(received.inboundActions, "exactly the declared authenticated payload replacement").toEqual([{ kind: "mutate", ordinal: 37 }]);
  expect(sent.outbound.find(packet => identity(packet) === identity(sent.source[37]))!.headerSize, "mutation size accounting has the complete RTP header").toBe(12);
  const expectedCarriers: ObservedRTP[] = sent.outbound.map(packet => identity(packet) === identity(sent.source[37]) ? { ...packet, payload,
    packetSize: packet.headerSize! + atob(payload).length + (packet.paddingSize ?? 0) } : packet);
  expect(received.inboundOriginal, "network input was intact before the declared authenticated-payload mutation").toEqual(sent.outbound);
  expect(received.inbound, "only the declared carrier payload was corrupted after SRTP authentication").toEqual(expectedCarriers);
  const expected = expectedDeliveries(sent.source, expectedCarriers, codecs, [sent.source[37].sequenceNumber]);
  expect(received.application.map(content), "the next valid RED carrier recovers exact media without corrupting history").toEqual(expected);
  expect(received.application.map(identity).sort()).toEqual(sent.source.map(identity).sort());
  expect(new Set(received.application.map(identity)).size).toBe(total);
  expect(sent.errors).toEqual([]);
  const next = received.inbound.find(packet => identity(packet) === identity(sent.source[38]))!;
  expect(decodeRED(next.payload).redundant.map(block => block.payload), "the immediate valid successor has authoritative original media")
    .toEqual([sent.source[36].payload, sent.source[37].payload]);
}

for (const malformed of [
  { name: "truncated redundant header", bytes: [0xef], error: "invalid RED payload: malformed RED payload: truncated redundant block header" },
  { name: "missing primary header", bytes: [0xef, 0, 0, 0], error: "invalid RED payload: malformed RED payload: missing primary block header" },
  { name: "redundant length beyond payload", bytes: [0xef, 0, 3, 255, 111, 1], error: "invalid RED payload: malformed RED payload: redundant block length exceeds payload" },
  { name: "unexpected primary payload type", bytes: [110, 1], error: "unexpected RED primary payload type: got 110, expected 111" },
  { name: "empty primary media", bytes: [111], error: "RED primary payload is empty" },
  { name: "more than 32 redundant blocks", bytes: [...Array.from({ length: 33 }, () => [0xef, 0, 0, 0]).flat(), 111, 1], error: "invalid RED payload: too many RED blocks" },
]) {
  test(`Opus RED rejects ${malformed.name} and accepts the next valid carrier`, { retry: 0 }, async ({ interop, skip }) => {
    await requireRED(interop, skip);
    await malformedScenario(interop, bytes64(malformed.bytes), malformed.error);
  });
}
