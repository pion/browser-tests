/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { test, expect } from "../fixtures/interop";

// Advertise only an audio codec in the first video section. The browser must
// reject that section and select the next accepted MID as the BUNDLE tag.
function unsupportedVideo(description: RTCSessionDescriptionInit): RTCSessionDescriptionInit {
  const sections = description.sdp!.split("m=");
  expect(sections[1]).toMatch(/^video /);
  const lines = sections[1].split("\r\n");
  lines[0] = lines[0].split(" ").slice(0, 3).join(" ") + " 96";
  sections[1] = lines.filter(line => !/^a=(rtpmap|fmtp|rtcp-fb):/.test(line)).join("\r\n") +
    "a=rtpmap:96 opus/48000/2\r\n";
  return { type: description.type, sdp: sections.join("m=") };
}

for (const trickle of [false, true]) {
  for (const direction of ["recvonly", "sendrecv"] as const) {
    test(`rejected first video preserves the ICE-lite bundle (${direction}, trickle=${trickle})`, async ({ interop }) => {
      const browser = interop.browserPeer();
      const pion = await interop.pionPeer({ behavior: "datachannel-echo", iceLite: true });
      await pion.addTransceiver("video", direction);
      await pion.addTransceiver("audio", "recvonly");
      const incoming = interop.event<RTCDataChannelEvent>(browser, "datachannel");
      await pion.createDataChannel("surviving-bundle");
      await pion.setLocalDescription(await pion.createOffer());
      const offer = unsupportedVideo(await interop.localDescription(pion));
      if (trickle) offer.sdp = offer.sdp!.replace(/^a=(?:candidate:.*|end-of-candidates)\r?\n/gm, "");
      await browser.setRemoteDescription(offer);
      await browser.setLocalDescription(await browser.createAnswer());
      const answer = await interop.localDescription(browser);
      expect(answer.sdp).toMatch(/^m=video 0 /m);
      expect(answer.sdp).toMatch(/^m=audio [1-9]\d* /m);
      expect(answer.sdp).toMatch(/^m=application [1-9]\d* /m);
      expect(answer.sdp).toMatch(/^a=group:BUNDLE 1 2\r?$/m);
      await pion.setRemoteDescription(answer);
      if (trickle) {
        const { candidates } = await pion.snapshot();
        expect(candidates.length).toBeGreaterThan(0);
        for (const candidate of candidates) await browser.addIceCandidate(candidate);
      }
      const { channel } = await incoming;
      await interop.waitForOpen(channel);
      const reply = interop.nextMessage(channel);
      channel.send("accepted bundle still works");
      expect(await reply).toBe("accepted bundle still works");
      expect(browser.connectionState).toBe("connected");
    });
  }
}
