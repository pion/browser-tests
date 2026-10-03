/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { test, expect } from "../fixtures/interop";

// https://github.com/pion/ice/pull/1014: remote mDNS candidates must resolve
// before SetLocalDescription starts Pion's first gather. Connectivity alone
// would miss dropped candidates because peer-reflexive discovery can recover.
for (const signaling of ["SDP", "addIceCandidate"] as const) {
  test.for([0, 1, 2])(`resolves browser mDNS candidates before gathering (${signaling}, pool=%i)`, async (iceCandidatePoolSize, { interop, skip }) => {
    if (/Firefox\//.test(navigator.userAgent)) skip("Firefox excluded from mDNS candidate-pool coverage");
    const browser = interop.browserPeer({ iceServers: [], iceCandidatePoolSize });
    const channel = browser.createDataChannel("mdns-before-gather");
    const candidates: RTCIceCandidate[] = [];
    browser.addEventListener("icecandidate", ({ candidate }) => {
      if (candidate?.type === "host" && candidate.protocol === "udp" && candidate.address?.endsWith(".local")) {
        candidates.push(candidate);
      }
    });
    await browser.setLocalDescription(await browser.createOffer());
    const offer = await interop.localDescription(browser);
    if (!candidates.length) skip("Browser did not gather any UDP .local host candidates; mDNS obfuscation is required");

    // Signal only mDNS candidates, excluding literal addresses and TCP fallback.
    const stripped = offer.sdp!.replace(/^a=(?:candidate:.*|end-of-candidates)\r?\n/gm, "");
    const pion = await interop.pionPeer({ behavior: "datachannel-echo" });
    await pion.setRemoteDescription({
      type: "offer",
      sdp: signaling === "SDP"
        ? stripped + candidates.map(candidate => `a=${candidate.candidate}\r\n`).join("")
        : stripped,
    });
    // Firefox only registers its mDNS names after receiving an answer:
    // https://bugzilla.mozilla.org/show_bug.cgi?id=1691189
    // CreateAnswer does not start Pion's gather. With no Pion candidates yet,
    const answer = await pion.createAnswer();
    expect(answer.sdp).not.toMatch(/^a=candidate:/m);
    await browser.setRemoteDescription(answer);
    if (signaling === "addIceCandidate") {
      for (const candidate of candidates) await pion.addIceCandidate(candidate.toJSON());
    }

    const remoteCandidates = async () => Object.values(await pion.stats()).filter((stat): stat is {
      type: string; candidateType: string; ip: string; port: number;
    } => (stat as { type: string }).type === "remote-candidate");
    await expect.poll(async () => (await remoteCandidates()).length, { timeout: 10_000 })
      .toBe(candidates.length);
    for (const remote of await remoteCandidates()) {
      expect(remote.candidateType).toBe("host");
      expect(remote.ip).toBeTruthy();
      expect(candidates.some(candidate => candidate.address === remote.ip)).toBe(true);
      expect(candidates.some(candidate => candidate.port === remote.port)).toBe(true);
    }
    const beforeGather = await pion.snapshot();
    expect(beforeGather.iceGatheringState).toBe("new");
    expect(beforeGather.localDescription).toBeNull();
    expect(beforeGather.candidates).toEqual([]);

    await pion.setLocalDescription(answer);
    await interop.localDescription(pion);
    for (const candidate of (await pion.snapshot()).candidates) {
      await browser.addIceCandidate(candidate);
    }
    await interop.waitForOpen(channel);
    const message = `resolved before gathering via ${signaling}`;
    const reply = interop.nextMessage(channel);
    channel.send(message);
    expect(await reply).toBe(message);
  });
}
