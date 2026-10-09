/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { test, expect } from "../fixtures/interop";
import { content, decodeRED, identity, requireRED, wireLedger } from "../fixtures/opus-red";
import { expectedDeliveries, recoveryScenario } from "../fixtures/red-recovery";

const packetCount = 256;
const total = packetCount + 2;
const naturalOrder = () => Array.from({ length: total }, (_, index) => index);
type Scenario = Awaited<ReturnType<typeof recoveryScenario>>;

function assertControlled(result: Scenario, dropped: number[] = [], order?: number[]) {
  const { sent, received, codecs } = result;
  expect(sent.droppedOutbound.map(identity), "the source applied exactly the declared losses")
    .toEqual(dropped.map(index => identity(sent.source[index])));
  wireLedger(sent.outbound, codecs, { source: sent.source });
  const byIdentity = new Map(sent.outbound.map(packet => [identity(packet), packet]));
  const intendedOrder = order ?? naturalOrder().filter(index => !dropped.includes(index));
  const carriers = intendedOrder.map(index => {
    const packet = byIdentity.get(identity(sent.source[index]));
    expect(packet, `declared carrier ordinal ${index} was transmitted`).toBeDefined();
    return packet!;
  });
  carriers.push(sent.outbound.at(-1)!);
  expect(received.inbound, "exact authenticated carriers after the declared receive order, including duplicates")
    .toEqual(carriers);
  if (order) {
    expect(received.inboundOriginal, "all authenticated original carriers arrived unchanged").toEqual(sent.outbound);
    expect(received.inboundActions.filter(action => action.kind === "hold").map(action => action.ordinal))
      .toEqual(naturalOrder().filter(index => !dropped.includes(index)));
    expect(received.inboundActions.filter(action => action.kind === "release" || action.kind === "duplicate").map(action => action.ordinal))
      .toEqual(order);
    const seen = new Set<number>();
    const duplicateOrdinals = order.filter(index => { const duplicate = seen.has(index); seen.add(index); return duplicate; });
    expect(received.inboundActions.filter(action => action.kind === "duplicate").map(action => action.ordinal)).toEqual(duplicateOrdinals);
  }
  const expected = expectedDeliveries(sent.source, carriers, codecs);
  expect(received.application.map(content), "exact independently predicted recovery order and bytes").toEqual(expected);
  const ids = received.application.map(identity);
  expect(new Set(ids).size, "application deliveries have no duplicate identities").toBe(ids.length);
  expect([...ids].sort(), "all source media is recoverable in this scenario").toEqual(sent.source.map(identity).sort());
  expect(sent.errors).toEqual([]);
  expect(received.errors).toEqual([]);
}

test("Opus RED suppresses duplicate plain and RED carriers", { retry: 0 }, async ({ interop, skip }) => {
  await requireRED(interop, skip);
  const order = naturalOrder().flatMap(index => index === 0 || index === 37 ? [index, index] : [index]);
  const result = await recoveryScenario(interop, { receiver: { inboundOrder: order } });
  expect(result.sent.outbound[0].payloadType, "the duplicated startup packet is plain Opus").toBe(result.codecs.opus);
  expect(result.sent.outbound[37].payloadType, "the later duplicated packet carries RED").toBe(result.codecs.red);
  assertControlled(result, [], order);
});

test("Opus RED suppresses a delayed primary already recovered from newer carriers", { retry: 0 }, async ({ interop, skip }) => {
  await requireRED(interop, skip);
  const order = naturalOrder().filter(index => index !== 37);
  order.splice(order.indexOf(39) + 1, 0, 37);
  const result = await recoveryScenario(interop, { receiver: { inboundOrder: order } });
  assertControlled(result, [], order);
  const delivered = result.received.application.map(identity);
  expect(delivered.filter(value => value === identity(result.sent.source[37]))).toHaveLength(1);
  expect(delivered.indexOf(identity(result.sent.source[37]))).toBeLessThan(delivered.indexOf(identity(result.sent.source[38])));
});

test("Opus RED uses an unseen copy from a late carrier whose primary was already recovered", { retry: 0 }, async ({ interop, skip }) => {
  await requireRED(interop, skip);
  const dropped = [37, 38];
  const order = naturalOrder().filter(index => !dropped.includes(index) && index !== 39);
  order.splice(order.indexOf(40) + 1, 0, 39);
  const result = await recoveryScenario(interop, { sender: { outboundDrop: dropped }, receiver: { inboundOrder: order } });
  assertControlled(result, dropped, order);
  const delivered = result.received.application.map(identity);
  expect(delivered.indexOf(identity(result.sent.source[37])), "the late useful copy arrives after the newer primary")
    .toBeGreaterThan(delivered.indexOf(identity(result.sent.source[40])));
  expect(delivered.filter(value => value === identity(result.sent.source[39])), "the late primary is suppressed").toHaveLength(1);
});

test("Opus RED survives a seeded mixture of loss, delay, and duplicate carriers", { retry: 0 }, async ({ interop, skip }) => {
  await requireRED(interop, skip);
  const seed = 0x2198ae5;
  let state = seed;
  const random = () => {
    state = Math.imul(state, 1664525) + 1013904223 >>> 0;
    return state;
  };
  const dropped: number[] = [], delayed: number[] = [], duplicated: number[] = [0];
  for (let block = 4; block < packetCount - 8; block += 8) {
    const action = (random() >>> 28) % 4;
    if (action === 0 || action === 1) dropped.push(block + 1);
    if (action === 1) dropped.push(block + 2);
    if (action === 2) delayed.push(block + 2);
    if (random() >>> 28 & 1) duplicated.push(block + 6);
  }
  const order = naturalOrder().filter(index => !dropped.includes(index));
  for (const index of delayed) {
    order.splice(order.indexOf(index), 1);
    order.splice(order.indexOf(index + 1) + 1, 0, index);
  }
  const replay = order.flatMap(index => duplicated.includes(index) ? [index, index] : [index]);
  expect(dropped.length, "the fixed seed exercises source loss").toBeGreaterThan(5);
  expect(delayed.length, "the fixed seed exercises reordered arrival").toBeGreaterThan(5);
  expect(duplicated.length, "the fixed seed exercises duplicate arrival").toBeGreaterThan(5);
  const result = await recoveryScenario(interop, { sender: { outboundDrop: dropped }, receiver: { inboundOrder: replay } });
  assertControlled(result, dropped, replay);
  console.log(`[RED mixed impairments] seed=${seed}, declared losses=${dropped.length}, delays=${delayed.length}, ` +
    `duplicates=${duplicated.length}, exact carrier and application order verified`);
});

test("Opus RED protects valid Opus packets with 20, 40, and 60 ms durations", { retry: 0 }, async ({ interop, skip }) => {
  await requireRED(interop, skip);
  const frames = [1, 2, 3] as const;
  let timestamp = 48000;
  const packetOverrides = naturalOrder().map(index => {
    if (index) timestamp += frames[(index - 1) % frames.length] * 960;
    return { index, timestamp, opusFrames: frames[index % frames.length] };
  });
  const dropped = [37, 38];
  const result = await recoveryScenario(interop, { source: { packetOverrides }, sender: { outboundDrop: dropped } });
  expect(result.sent.source.map(packet => packet.timestamp), "the source actually applied the declared timestamp cadence")
    .toEqual(packetOverrides.map(packet => packet.timestamp));
  result.sent.source.forEach((packet, index) => {
    const bytes = Uint8Array.from(atob(packet.payload), value => value.charCodeAt(0));
    const frameCount = packetOverrides[index].opusFrames;
    expect(bytes[0] >>> 3, "embedded CELT frame configuration is preserved").toBe(31);
    expect(bytes[0] & 3, "single-frame code0 or multi-frame CBR code3").toBe(frameCount === 1 ? 0 : 3);
    if (frameCount === 1) {
      expect(bytes.length).toBe(160);
    } else {
      expect(bytes[1], "un-padded CBR count is the declared valid Opus duration").toBe(frameCount);
      expect(bytes.length).toBe(2 + frameCount * 159);
      const frame = bytes.subarray(2, 161);
      for (let copy = 1; copy < frameCount; copy++) {
        expect(bytes.subarray(2 + copy * 159, 2 + (copy + 1) * 159), "CBR frames exactly reuse the valid CELT frame").toEqual(frame);
      }
    }
  });
  assertControlled(result, dropped);
});

for (const discontinuity of ["silence timestamp gap", "sequence gap", "equal timestamp"] as const) {
  test(`Opus RED resets unsafe sender history after a ${discontinuity}`, { retry: 0 }, async ({ interop, skip }) => {
    await requireRED(interop, skip);
    const packetOverrides = naturalOrder().filter(index => index >= 64).map(index => ({
      index,
      ...(discontinuity === "sequence gap" ? { sequenceNumber: 1000 + index + 5 } : {
        timestamp: 48000 + index * 960 + (discontinuity === "silence timestamp gap" ? 20000 : -960),
      }),
    }));
    const result = await recoveryScenario(interop, { source: { packetOverrides } });
    for (const { index, ...header } of packetOverrides) expect(result.sent.source[index]).toMatchObject(header);
    const at = (index: number) => result.sent.outbound.find(packet => identity(packet) === identity(result.sent.source[index]))!;
    expect(at(64).payloadType, "the first packet after unsafe history is plain Opus").toBe(result.codecs.opus);
    expect(decodeRED(at(65).payload).redundant.map(block => block.payload), "only post-reset audio can be copied")
      .toEqual([result.sent.source[64].payload]);
    expect(decodeRED(at(66).payload).redundant.map(block => block.payload), "two-copy history resumes after the reset")
      .toEqual([result.sent.source[64].payload, result.sent.source[65].payload]);
    assertControlled(result);
  });
}
