/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { test, expect } from "../fixtures/interop";
import { audioSink, oscillatorSource } from "../fixtures/media";

import { audioCodecs, wireLedger, identity, content, preferAudioCodecs, requireRED } from "../fixtures/opus-red";

for (const offerer of ["browser", "pion"] as const) {
  test(`Opus RED audio round trip (${offerer} offers)`, async ({ interop, skip }) => {
    await requireRED(interop, skip, "Send", "Receive");

    const media = await oscillatorSource();
    const browser = interop.browserPeer();
    const playback = await audioSink(browser);
    try {
      const pion = await interop.pionPeer({ behavior: "media-echo", opusRED: true });
      const track = media.stream.getAudioTracks()[0];
      browser.addTrack(track, media.stream);
      const transceiver = browser.getTransceivers().find(item => item.sender.track === track)!;
      preferAudioCodecs(transceiver, "receive");
      if (offerer === "browser") await interop.negotiate(browser, pion);
      else await interop.negotiate(pion, browser);
      const incoming = audioCodecs(browser.localDescription);
      const outgoing = audioCodecs(browser.remoteDescription);
      const inbound = async () => Array.from((await browser.getStats()).values()).find(stat =>
        stat.type === "inbound-rtp" && stat.kind === "audio") as RTCInboundRtpStreamStats | undefined;
      const decodedSamples = async () => {
        const stats = await inbound();
        return (stats?.totalSamplesReceived ?? 0) - (stats?.concealedSamples ?? 0);
      };
      let errors: string[] = [];
      await expect.poll(async () => {
        errors = (await pion.rtp()).errors;
        return errors.length > 0 || ((await inbound())?.packetsReceived ?? 0) > 25;
      }, { timeout: 15_000 }).toBe(true);
      expect(errors, "Pion RED read/write failure interrupted the round trip").toEqual([]);
      const before = await decodedSamples();
      await expect.poll(decodedSamples, { timeout: 15_000 }).toBeGreaterThan(before + 4800);
      await expect.poll(playback.rms, { timeout: 15_000 }).toBeGreaterThan(0.01);
      expect(playback.receivedTrack()).toBe(true);
      expect(browser.connectionState).toBe("connected");

      const observations = await pion.rtp();
      expect(observations.errors, "Pion RED read/write errors").toEqual([]);
      const received = wireLedger(observations.inbound, incoming);
      const sent = wireLedger(observations.outbound, outgoing);
      expect(observations.outbound[0].payloadType, "first Pion packet is ordinary Opus").toBe(outgoing.opus);
      expect(sent.depths, "one-copy Pion startup").toContain(1);
      expect(sent.depths, "two-copy Pion history").toContain(2);
      expect(Math.max(...sent.depths)).toBe(2);

      const delivered = new Set<string>();
      for (const packet of observations.application) {
        expect(packet.payloadType, "application receives Opus").toBe(incoming.opus);
        expect(delivered.has(identity(packet)), "no duplicate application delivery").toBe(false);
        expect(content(packet), "exact Opus payload and RTP identity from incoming carriers")
          .toEqual(received.sources.get(identity(packet)));
        delivered.add(identity(packet));
      }
      expect(delivered.size).toBeGreaterThan(25);
      // Snapshot may contain an inbound carrier still waiting for application delivery.
      // All earlier sources through the latest delivery must already be present.
      const origin = observations.inbound[0].sequenceNumber;
      const position = (sequence: number) => (sequence - origin + 0x8000 & 0xffff) - 0x8000;
      const last = Math.max(...observations.application.map(packet => position(packet.sequenceNumber)));
      for (const packet of received.sources.values()) {
        if (position(packet.sequenceNumber) <= last) expect(delivered.has(identity(packet)), "complete delivery before snapshot tail").toBe(true);
      }
      const echoed = new Map(observations.application.map(packet => [`${packet.sequenceNumber}/${packet.timestamp}`, packet.payload]));
      for (const packet of sent.primary.values()) {
        expect(packet.payload, "Pion echoes the application Opus bytes")
          .toBe(echoed.get(`${packet.sequenceNumber}/${packet.timestamp}`));
      }
      const browserStats = Array.from((await browser.getStats()).values());
      expect(browserStats.some(stat => stat.type === "outbound-rtp" && stat.kind === "audio" && stat.packetsSent > 25)).toBe(true);
      await expect.poll(async () => {
        const stats = Object.values(await pion.stats()) as RTCInboundRtpStreamStats[];
        return stats.find(stat => stat.type === "inbound-rtp" && stat.kind === "audio")?.packetsReceived ?? 0;
      }, { timeout: 5_000 }).toBeGreaterThan(25);
      // Pion currently exposes receiver RTP stats. Browser remote-inbound stats
      // prove normal Pion receiver reports arrive; sender report metrics vary.
      let senderReportPackets: number | undefined;
      await expect.poll(async () => {
        const stats = Array.from((await browser.getStats()).values());
        senderReportPackets = stats.find(stat => stat.type === "remote-outbound-rtp" && stat.kind === "audio")?.packetsSent;
        return stats.some(stat => stat.type === "remote-inbound-rtp" && stat.kind === "audio");
      }, { timeout: 5_000 }).toBe(true);
      expect((await pion.rtp()).errors, "no later Pion RED read/write failures").toEqual([]);
      console.log(`[Opus RED ${offerer} offers] inbound=${observations.inbound.length}, ` +
        `outbound=${observations.outbound.length}, Opus deliveries=${delivered.size}, ` +
        `verified copies=${received.copies}/${sent.copies}, inferred startup copies=${received.inferredCopies}/${sent.inferredCopies}, ` +
        `padding-only RTP=${received.padding}/${sent.padding}, decoded samples=${await decodedSamples()}, ` +
        `RTCP receiver report received, sender report packets=${senderReportPackets ?? "unavailable"}, ` +
        `bounded snapshot truncated=${observations.truncated}`);
    } finally {
      await playback.close();
      await media.close();
    }
  });
}
