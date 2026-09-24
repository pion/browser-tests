/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { test, expect } from "../fixtures/interop";

for (const ordered of [true, false]) {
  test(`echoes text (ordered=${ordered})`, async ({ interop }) => {
    const channel = await interop.openDataChannel({ ordered });
    const reply = interop.nextMessage(channel);
    channel.send("hello pion");
    expect(await reply).toBe("hello pion");
  });
}

test("echoes binary", async ({ interop }) => {
  const channel = await interop.openDataChannel();
  channel.binaryType = "arraybuffer";
  const reply = interop.nextMessage(channel);
  channel.send(new Uint8Array([0, 1, 128, 255]));
  expect(new Uint8Array(await reply as ArrayBuffer)).toEqual(new Uint8Array([0, 1, 128, 255]));
});

test("keeps multiple peers independent and permits replacement", async ({ interop }) => {
  const browser = interop.browserPeer();
  const pion = await interop.pionPeer({ behavior: "datachannel-echo" });
  const first = browser.createDataChannel("first");
  await interop.negotiate(browser, pion);
  await interop.waitForOpen(first);
  const second = await interop.openDataChannel();
  for (const [channel, message] of [[first, "first"], [second, "second"]] as const) {
    const reply = interop.nextMessage(channel);
    channel.send(message);
    expect(await reply).toBe(message);
  }
  browser.close();
  await pion.close();
  const replacement = await interop.openDataChannel();
  for (const channel of [second, replacement]) {
    const reply = interop.nextMessage(channel);
    channel.send("still alive");
    expect(await reply).toBe("still alive");
  }
});

test("Pion offers with explicit signaling and creates the channel", async ({ interop }) => {
  const browser = interop.browserPeer();
  const pion = await interop.pionPeer({ behavior: "datachannel-echo" });
  const incoming = interop.event<RTCDataChannelEvent>(browser, "datachannel");
  await pion.createDataChannel("from-pion");
  await pion.setLocalDescription(await pion.createOffer());
  const offer = await interop.localDescription(pion);
  await browser.setRemoteDescription(JSON.parse(JSON.stringify(offer)));
  await browser.setLocalDescription(await browser.createAnswer());
  await pion.setRemoteDescription(await interop.localDescription(browser));
  const { channel } = await incoming;
  await interop.waitForOpen(channel);
  const reply = interop.nextMessage(channel);
  channel.send("pion offered");
  expect(await reply).toBe("pion offered");
});

test("renegotiates an ICE restart on the same peers", async ({ interop }) => {
  const browser = interop.browserPeer();
  const pion = await interop.pionPeer({ behavior: "datachannel-echo" });
  const channel = browser.createDataChannel("restart");
  await interop.negotiate(browser, pion);
  await interop.waitForOpen(channel);
  const before = browser.localDescription!.sdp.match(/a=ice-ufrag:(.+)/)?.[1];
  await interop.negotiate(browser, pion, { iceRestart: true });
  expect(browser.localDescription!.sdp.match(/a=ice-ufrag:(.+)/)?.[1]).not.toBe(before);
  expect((await pion.snapshot()).signalingState).toBe("stable");
  const reply = interop.nextMessage(channel);
  channel.send("after restart");
  expect(await reply).toBe("after restart");
});

test("exchanges ICE candidates separately from descriptions", async ({ interop }) => {
  const browser = interop.browserPeer();
  const pion = await interop.pionPeer({ behavior: "datachannel-echo" });
  const channel = browser.createDataChannel("separate-candidates");
  const candidates: RTCIceCandidateInit[] = [];
  browser.addEventListener("icecandidate", event => {
    if (event.candidate) candidates.push(event.candidate.toJSON());
  });
  const withoutCandidates = (description: RTCSessionDescriptionInit): RTCSessionDescriptionInit => ({
    type: description.type,
    sdp: description.sdp!.replace(/^a=(?:candidate:.*|end-of-candidates)\r?\n/gm, ""),
  });
  await browser.setLocalDescription(await browser.createOffer());
  await pion.setRemoteDescription(withoutCandidates(await interop.localDescription(browser)));
  await pion.setLocalDescription(await pion.createAnswer());
  await browser.setRemoteDescription(withoutCandidates(await interop.localDescription(pion)));
  const remote = await pion.snapshot();
  expect(candidates.length).toBeGreaterThan(0);
  expect(remote.candidates.length).toBeGreaterThan(0);
  for (const candidate of candidates) await pion.addIceCandidate(candidate);
  for (const candidate of remote.candidates) await browser.addIceCandidate(candidate);
  await interop.waitForOpen(channel);
  const reply = interop.nextMessage(channel);
  channel.send("separate signaling");
  expect(await reply).toBe("separate signaling");
});
