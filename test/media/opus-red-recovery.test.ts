/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { test, expect } from "../fixtures/interop";
import { requireRED } from "../fixtures/opus-red";
import { assertRecovery, recoveryScenario } from "../fixtures/red-recovery";

for (const [name, outboundDrop] of [
  ["isolated packet", [37]], ["initial plain Opus packet", [0]], ["adjacent two packets", [37, 38]],
] as const) {
  test(`Opus RED exactly recovers ${name}`, async ({ interop, skip }) => {
    await requireRED(interop, skip);
    const { sent, received, codecs } = await recoveryScenario(interop, { sender: { outboundDrop: [...outboundDrop] } });
    expect(sent.droppedOutbound.map(packet => packet.sequenceNumber)).toEqual(outboundDrop.map(index => 1000 + index));
    assertRecovery(sent, received, codecs);
  });
}
