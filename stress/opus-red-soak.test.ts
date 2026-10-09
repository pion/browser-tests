/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { test, expect } from "../test/fixtures/interop";
import { audioSink, oscillatorSource } from "../test/fixtures/media";
import { audioCodecs, preferAudioCodecs, requireRED, wireLedger } from "../test/fixtures/opus-red";

const durationMs = 30 * 60_000;
const checkpointMs = 15_000;
const observationPrefixLimit = 256;

const client = navigator as Navigator & { userAgentData?: {
  getHighEntropyValues(hints: string[]): Promise<{ fullVersionList?: { brand: string; version: string }[] }>;
} };
const versions = await client.userAgentData?.getHighEntropyValues(["fullVersionList"]).catch(() => undefined);
console.log(`[Opus RED soak] browser=${navigator.userAgent}; versions=${versions?.fullVersionList?.map(value => `${value.brand}/${value.version}`).join(", ") ?? "unavailable"}`);

test("Opus RED live audio soak (30 minutes)", { timeout: 31 * 60_000, retry: 0 }, async ({ interop, skip }) => {
  skip(import.meta.env.VITE_OPUS_RED_SOAK !== "1", "Set VITE_OPUS_RED_SOAK=1 to run the full 30-minute soak");
  await requireRED(interop, skip, "Send", "Receive");
  const media = await oscillatorSource();
  let playback: Awaited<ReturnType<typeof audioSink>> | undefined;
  const browser = interop.browserPeer();
  const interruptions = new Set<RTCPeerConnectionState>();
  const stateChanged = () => {
    if (browser.connectionState !== "connected") interruptions.add(browser.connectionState);
  };
  try {
    playback = await audioSink(browser);
    const sink = playback;
    const pion = await interop.pionPeer({ behavior: "media-echo", opusRED: true });
    const track = media.stream.getAudioTracks()[0];
    browser.addTrack(track, media.stream);
    const transceiver = browser.getTransceivers().find(item => item.sender.track === track)!;
    preferAudioCodecs(transceiver, "receive");
    await interop.negotiate(browser, pion);
    const incoming = audioCodecs(browser.localDescription);
    const outgoing = audioCodecs(browser.remoteDescription);
    console.log(`[Opus RED soak] browser SDP:\n${browser.localDescription?.sdp}`);
    console.log(`[Opus RED soak] Pion SDP:\n${browser.remoteDescription?.sdp}`);
    const audioStats = async () => {
      const report = Array.from((await browser.getStats()).values());
      const received = report.find(stat => stat.type === "inbound-rtp" && stat.kind === "audio") as RTCInboundRtpStreamStats | undefined;
      const sent = report.find(stat => stat.type === "outbound-rtp" && stat.kind === "audio") as RTCOutboundRtpStreamStats | undefined;
      return {
        received: received?.packetsReceived ?? 0,
        sent: sent?.packetsSent ?? 0,
        samples: (received?.totalSamplesReceived ?? 0) - (received?.concealedSamples ?? 0),
      };
    };
    await expect.poll(async () => {
      const [stats, observations] = await Promise.all([audioStats(), pion.rtp()]);
      expect(observations.errors, "Pion RED read/write errors during startup").toEqual([]);
      return stats.received > 25 && stats.sent > 25 && stats.samples > 4800;
    }, { timeout: 15_000 }).toBe(true);
    await expect.poll(sink.rms, { timeout: 15_000 }).toBeGreaterThan(0.01);
    await expect.poll(async () => (await pion.snapshot()).connectionState, { timeout: 10_000 }).toBe("connected");
    expect(sink.receivedTrack(), "remote audio is attached to playback").toBe(true);
    expect(browser.connectionState).toBe("connected");

    let previousAudio = await audioStats();
    let previousRTP = await pion.rtp();
    wireLedger(previousRTP.inbound, incoming);
    wireLedger(previousRTP.outbound, outgoing);
    expect(previousRTP.totals, "RTP counters are available beyond the retained prefix").toBeDefined();
    const initialStateCount = (await pion.snapshot()).states.length;
    browser.addEventListener("connectionstatechange", stateChanged);
    const started = performance.now();
    for (let checkpoint = 1; checkpoint <= durationMs / checkpointMs; checkpoint++) {
      const deadline = started + checkpoint * checkpointMs;
      while (performance.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, Math.ceil(deadline - performance.now())));
      }
      const [stats, observations, snapshot] = await Promise.all([audioStats(), pion.rtp(), pion.snapshot()]);
      const context = `soak checkpoint ${checkpoint}, elapsed ${Math.floor((performance.now() - started) / 1000)}s`;
      const rms = sink.rms();
      console.log(`[Opus RED soak] ${context}: audio diagnostics ${JSON.stringify({ rms,
        source: media.diagnostics(), sink: sink.diagnostics() })}`);
      expect(browser.connectionState, context).toBe("connected");
      expect(snapshot.connectionState, context).toBe("connected");
      expect(Array.from(interruptions), "browser had no connection interruption during the soak").toEqual([]);
      expect(snapshot.states.slice(initialStateCount).filter(state => state !== "connected"),
        "Pion had no connection interruption during the soak").toEqual([]);
      expect(observations.errors, `${context}: Pion RED read/write errors`).toEqual([]);
      expect(stats.received, `${context}: received browser audio packets advance`).toBeGreaterThan(previousAudio.received);
      expect(stats.sent, `${context}: sent browser audio packets advance`).toBeGreaterThan(previousAudio.sent);
      expect(stats.samples, `${context}: nonconcealed decoded samples advance`).toBeGreaterThan(previousAudio.samples + 4800);
      expect(rms, `${context}: non-silent sine audio`).toBeGreaterThan(0.01);
      for (const direction of ["inbound", "outbound", "application"] as const) {
        expect(observations.totals[direction], `${context}: ${direction} continues beyond the prefix`)
          .toBeGreaterThan(previousRTP.totals[direction]);
        expect(observations[direction].length, `${context}: ${direction} evidence remains bounded`)
          .toBeLessThanOrEqual(observationPrefixLimit);
      }
      for (const direction of ["inboundRED", "outboundRED"] as const) {
        expect(observations.totals[direction], `${context}: actual ${direction} carriers continue after the retained prefix`)
          .toBeGreaterThan(previousRTP.totals[direction]);
      }
      expect(observations.source.length, `${context}: source evidence remains bounded`).toBeLessThanOrEqual(observationPrefixLimit);
      expect(observations.truncated, `${context}: a long stream exceeds the retained prefix`).toBe(true);
      console.log(`[Opus RED soak] ${context}, browser packets=${stats.sent}/${stats.received}, ` +
        `nonconcealed samples=${stats.samples}, wire packets=${observations.totals.inbound}/${observations.totals.outbound}, ` +
        `Opus deliveries=${observations.totals.application}, bounded prefix=${observations.inbound.length}/${observations.outbound.length}`);
      previousAudio = stats;
      previousRTP = observations;
    }
    expect(performance.now() - started, "the live measurement ran for the full 30 minutes").toBeGreaterThanOrEqual(durationMs);
    expect((await pion.rtp()).errors, "no final Pion RED read/write errors").toEqual([]);
    console.log("[Opus RED soak] completed the full 30-minute live audio measurement");
  } finally {
    browser.removeEventListener("connectionstatechange", stateChanged);
    try {
      await playback?.close();
    } finally {
      await media.close();
    }
  }
});
