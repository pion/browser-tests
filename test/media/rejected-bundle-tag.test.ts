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

test("trickle candidates follow the changed BUNDLE tag after the answer", async ({ interop }) => {
  const browser = interop.browserPeer();
  const pion = await interop.pionPeer({
    behavior: "datachannel-echo", iceLite: true, pauseIceGathering: true,
  });
  await pion.addTransceiver("video", "recvonly");
  await pion.addTransceiver("audio", "recvonly");
  const incoming = interop.event<RTCDataChannelEvent>(browser, "datachannel");
  await pion.createDataChannel("late-trickle");
  const offer = await pion.createOffer();
  await pion.setLocalDescription(offer);
  expect(offer.sdp).toMatch(/^a=group:BUNDLE 0 1 2\r?$/m);
  expect(offer.sdp).not.toMatch(/^a=candidate:/m);
  await browser.setRemoteDescription(unsupportedVideo(offer));
  const answer = await browser.createAnswer();
  await browser.setLocalDescription(answer);
  expect(answer.sdp).toMatch(/^m=video 0 /m);
  expect(answer.sdp).toMatch(/^a=group:BUNDLE 1 2\r?$/m);
  answer.sdp = answer.sdp!.replace(/^a=(?:candidate:.*|end-of-candidates)\r?\n/gm, "");
  await pion.setRemoteDescription(answer);
  expect((await pion.snapshot()).candidates).toEqual([]);
  await pion.resumeIceGathering();
  await interop.localDescription(pion);
  const { candidates } = await pion.snapshot();
  expect(candidates.length).toBeGreaterThan(0);
  for (const candidate of candidates) {
    expect.soft(candidate.sdpMid).toBe("1");
    expect.soft(candidate.sdpMLineIndex).toBe(1);
    await browser.addIceCandidate(candidate);
  }
  const { channel } = await incoming;
  await interop.waitForOpen(channel);
  const reply = interop.nextMessage(channel);
  channel.send("late trickle on the accepted bundle");
  expect(await reply).toBe("late trickle on the accepted bundle");
  expect(browser.connectionState).toBe("connected");
});

for (const iceRestart of [false, true]) {
  test(`renegotiation after rejecting the BUNDLE tag preserves connectivity (iceRestart=${iceRestart})`, async ({ interop }) => {
    const browser = interop.browserPeer();
    const pion = await interop.pionPeer({ behavior: "datachannel-echo", iceLite: true });
    await pion.addTransceiver("video", "recvonly");
    await pion.addTransceiver("audio", "recvonly");
    const incoming = interop.event<RTCDataChannelEvent>(browser, "datachannel");
    await pion.createDataChannel("renegotiated-bundle");
    await pion.setLocalDescription(await pion.createOffer());
    const offer = await interop.localDescription(pion);
    await browser.setRemoteDescription(offer);
    const answer = await browser.createAnswer();
    answer.sdp = answer.sdp!
      .replace(/^m=video \d+ /m, "m=video 0 ")
      .replace(/^a=group:BUNDLE 0 1 2\r?$/m, "a=group:BUNDLE 1 2\r");
    await browser.setLocalDescription(answer);
    expect(answer.sdp).toMatch(/^m=video 0 /m);
    expect(answer.sdp).toMatch(/^a=group:BUNDLE 1 2\r?$/m);
    await pion.setRemoteDescription(answer);
    const { channel } = await incoming;
    await interop.waitForOpen(channel);
    const firstReply = interop.nextMessage(channel);
    channel.send("before renegotiation");
    expect(await firstReply).toBe("before renegotiation");

    await pion.setLocalDescription(await pion.createOffer({ iceRestart }));
    const reoffer = await interop.localDescription(pion);
    const firstUfrag = offer.sdp!.match(/^a=ice-ufrag:(\S+)/m)![1];
    const nextUfrag = reoffer.sdp!.match(/^a=ice-ufrag:(\S+)/m)![1];
    if (iceRestart) expect(nextUfrag).not.toBe(firstUfrag);
    else expect(nextUfrag).toBe(firstUfrag);
    await browser.setRemoteDescription(reoffer);
    const reanswer = await browser.createAnswer();
    await browser.setLocalDescription(reanswer);
    await pion.setRemoteDescription(reanswer);
    const secondReply = interop.nextMessage(channel);
    channel.send("after renegotiation");
    expect(await secondReply).toBe("after renegotiation");
    expect(browser.connectionState).toBe("connected");
  });
}
