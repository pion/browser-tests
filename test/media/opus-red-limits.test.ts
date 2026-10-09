/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { test, expect } from "../fixtures/interop";
import { decodeRED, identity, requireRED } from "../fixtures/opus-red";
import { assertRecovery, recoveryScenario } from "../fixtures/red-recovery";

test("Opus RED leaves the oldest loss unavailable after a three-carrier burst", { retry: 0 }, async ({ interop, skip }) => {
  await requireRED(interop, skip);
  const { sent, received, codecs } = await recoveryScenario(interop, { sender: { outboundDrop: [37, 38, 39] } });
  expect(sent.droppedOutbound.map(identity)).toEqual([37, 38, 39].map(index => identity(sent.source[index])));
  const next = received.inbound.find(packet => identity(packet) === identity(sent.source[40]))!;
  const decoded = decodeRED(next.payload);
  expect(decoded.redundant.map(block => block.payload), "the next carrier has only the two newest missing sources")
    .toEqual([38, 39].map(index => sent.source[index].payload));
  expect(decoded.redundant.map(block => block.offset)).toEqual([1920, 960]);
  assertRecovery(sent, received, codecs, { missing: [37] });
});

test("Opus RED recovers only one loss when the packet budget admits one copy", { retry: 0 }, async ({ interop, skip }) => {
  await requireRED(interop, skip);
  // 12-byte RTP header + primary RED header + two 160-byte payloads + one
  // redundant header = 337. A second redundant copy would require 501 bytes.
  const { sent, received, codecs } = await recoveryScenario(interop, {
    sender: { outboundDrop: [37, 38] }, maxPacketSize: 337,
  });
  expect(sent.droppedOutbound.map(identity)).toEqual([37, 38].map(index => identity(sent.source[index])));
  const carriers = sent.outbound.filter(packet => packet.payloadType === codecs.red);
  expect(carriers.length).toBeGreaterThan(25);
  for (const packet of carriers) {
    const decoded = decodeRED(packet.payload);
    expect(decoded.redundant, "the negotiated RED stream is constrained to one useful copy").toHaveLength(1);
    expect(12 + atob(packet.payload).length, "every RED packet fits the complete RTP budget").toBe(337);
  }
  const next = received.inbound.find(packet => identity(packet) === identity(sent.source[39]))!;
  expect(decodeRED(next.payload).redundant[0].payload, "the remaining copy protects the newest missing source")
    .toBe(sent.source[38].payload);
  assertRecovery(sent, received, codecs, { missing: [37] });
});

for (const dropped of [[255], [254, 255]]) {
  test(`Opus RED cannot recover ${dropped.length} terminal loss(es) without later audio`, { retry: 0 }, async ({ interop, skip }) => {
    await requireRED(interop, skip);
    const { sent, received, codecs } = await recoveryScenario(interop, {
      source: { trailers: 0 }, sender: { outboundDrop: dropped },
    });
    expect(sent.source).toHaveLength(256);
    expect(sent.droppedOutbound.map(identity)).toEqual(dropped.map(index => identity(sent.source[index])));
    expect(received.inbound.at(-1), "completion proves drainage but carries no recovery audio")
      .toMatchObject({ padding: true, paddingSize: 1, payload: "" });
    assertRecovery(sent, received, codecs, { missing: dropped });
  });
}
