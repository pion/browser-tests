/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { expect, type AudioCodecOrder, type Interop, type ObservedRTP } from "./interop";

export type Codecs = { opus: number; red: number };
type Block = { payloadType: number; offset: number; payload: string };

// Matrix validation requires Pion while unsupported browser directions skip.
// Strict mode also requires every browser direction used by the selected case.
export async function requireRED(interop: Interop, skip: (condition: boolean, note?: string) => void,
  ...directions: ("Send" | "Receive")[]) {
  const mode = import.meta.env.VITE_REQUIRE_OPUS_RED;
  expect([undefined, "", "pion", "1"], "VITE_REQUIRE_OPUS_RED must be unset, pion, or 1").toContain(mode);
  const capabilities = ["pion.opusRED", ...directions.map(direction => `browser.opusRED${direction}` as const)] as const;
  for (const name of capabilities) {
    const support = await interop.features.check(name);
    const reason = `${name}: ${support.reason ?? "required for RED validation"}`;
    if (mode === "1" || mode === "pion" && name === "pion.opusRED") expect(support.supported, reason).toBe(true);
    else skip(!support.supported, reason);
  }
}

export function preferAudioCodecs(transceiver: RTCRtpTransceiver, direction: "send" | "receive",
  order: AudioCodecOrder = "red-first") {
  const capabilities = direction === "send" ? RTCRtpSender.getCapabilities("audio") : RTCRtpReceiver.getCapabilities("audio");
  // Pass the browser's exact native records; do not invent or remap payload types.
  const codecs = capabilities!.codecs.filter(codec => codec.mimeType.toLowerCase() === "audio/opus" ||
    order !== "opus-only" && codec.mimeType.toLowerCase() === "audio/red");
  codecs.sort((left, right) => (order === "red-first" ? 1 : -1) *
    (Number(right.mimeType.toLowerCase() === "audio/red") - Number(left.mimeType.toLowerCase() === "audio/red")));
  expect(codecs.some(codec => codec.mimeType.toLowerCase() === "audio/opus"), "browser supports Opus").toBe(true);
  transceiver.setCodecPreferences(codecs);
}

export function opusOnlyCodec(description: RTCSessionDescriptionInit | null): number {
  const audio = description?.sdp?.split(/(?=^m=)/m).find(section => section.startsWith("m=audio "));
  expect(audio, "negotiated audio section").toBeDefined();
  expect(audio, "answer must exclude unnegotiated RED").not.toMatch(/^a=rtpmap:\d+ red\//mi);
  const opus = audio!.match(/^a=rtpmap:(\d+) opus\/48000\/2\r?$/mi);
  expect(opus, "negotiated Opus").not.toBeNull();
  expect(audio!.split(/\r?\n/)[0].split(" ").slice(3).map(Number), "only Opus is negotiated")
    .toEqual([Number(opus![1])]);
  return Number(opus![1]);
}

export function opusLedger(packets: ObservedRTP[], payloadType: number, source?: ObservedRTP[]) {
  const authoritative = source?.map(content);
  const primary = new Map<string, ObservedRTP>();
  let padding = 0;
  for (const packet of packets) {
    expect(packet.payloadType, "fallback wire/application packet uses negotiated Opus").toBe(payloadType);
    if (packet.padding && packet.payload === "") {
      expect(packet.paddingSize, "valid Opus padding-only RTP").toBeGreaterThan(0);
      padding++;
      continue;
    }
    expect(packet.payload.length, "nonempty Opus media").toBeGreaterThan(0);
    expect(primary.has(identity(packet)), "no duplicate Opus packet identities").toBe(false);
    const value = content(packet);
    if (authoritative) expect(value, "plain Opus matches source bytes and RTP identity")
      .toEqual(authoritative.find(packet => identity(packet) === identity(value)));
    primary.set(identity(value), value);
  }
  expect(primary.size, "actual plain Opus media").toBeGreaterThan(25);
  return { primary, padding };
}

export function audioCodecs(description: RTCSessionDescriptionInit | null): Codecs {
  const audio = description?.sdp?.split(/(?=^m=)/m).find(section => section.startsWith("m=audio "));
  expect(audio, "negotiated audio section").toBeDefined();
  const payloads = audio!.split(/\r?\n/)[0].split(" ").slice(3).map(Number);
  const type = (name: string) => {
    const match = audio!.match(new RegExp(`^a=rtpmap:(\\d+) ${name}/48000/2\\r?$`, "mi"));
    expect(match, `negotiated ${name}/48000/2`).not.toBeNull();
    const pt = Number(match![1]);
    expect(payloads).toContain(pt);
    return pt;
  };
  const opus = type("opus");
  const red = type("red");
  const association = audio!.match(new RegExp(`^a=fmtp:${red} ([^\\r\\n]+)`, "m"));
  expect(association, "RED fmtp association").not.toBeNull();
  const blocks = association![1].trim().split("/").map(Number);
  expect(blocks.length).toBeGreaterThan(0);
  expect(blocks.every(pt => pt === opus), "RED protects negotiated Opus").toBe(true);
  return { opus, red };
}

// Independent RFC 2198 decoder: headers first, then redundant data, then primary.
export function decodeRED(payload: string): { redundant: Block[]; primary: Block } {
  const bytes = Uint8Array.from(atob(payload), character => character.charCodeAt(0));
  const headers: { payloadType: number; offset: number; length: number }[] = [];
  let cursor = 0;
  while (cursor < bytes.length && bytes[cursor] & 0x80) {
    if (cursor + 4 > bytes.length) throw new Error("Truncated RED header");
    headers.push({ payloadType: bytes[cursor] & 0x7f,
      offset: (bytes[cursor + 1] << 6) | (bytes[cursor + 2] >> 2),
      length: ((bytes[cursor + 2] & 3) << 8) | bytes[cursor + 3] });
    cursor += 4;
  }
  if (cursor >= bytes.length) throw new Error("Missing RED primary header");
  const primaryType = bytes[cursor++];
  const encode = (start: number, end: number) => btoa(String.fromCharCode(...bytes.subarray(start, end)));
  const redundant = headers.map(header => {
    if (cursor + header.length > bytes.length) throw new Error("Truncated RED redundant data");
    const block = { payloadType: header.payloadType, offset: header.offset,
      payload: encode(cursor, cursor + header.length) };
    cursor += header.length;
    return block;
  });
  if (cursor === bytes.length) throw new Error("Empty RED primary data");
  return { redundant, primary: { payloadType: primaryType, offset: 0, payload: encode(cursor, bytes.length) } };
}

export const identity = (packet: ObservedRTP) => `${packet.ssrc}/${packet.sequenceNumber}/${packet.timestamp}`;
export const content = ({ ssrc, sequenceNumber, timestamp, payloadType, payload }: ObservedRTP): ObservedRTP =>
  ({ ssrc, sequenceNumber, timestamp, payloadType, payload });

export function wireLedger(packets: ObservedRTP[], codecs: Codecs, options: { source?: ObservedRTP[]; inferStartup?: boolean } = {}) {
  const authoritative = options.source?.map(content);
  const primary = new Map<string, ObservedRTP>();
  const sources = new Map<string, ObservedRTP>();
  const carriers: { packet: ObservedRTP; blocks: Block[] }[] = [];
  const first = new Map<number, ObservedRTP>();
  const depths: number[] = [];
  let padding = 0;
  let knownCopies = 0;
  let inferredCopies = 0;
  const add = (packet: ObservedRTP) => {
    const previous = sources.get(identity(packet));
    if (previous) expect(packet.payload, "consistent RED source bytes").toBe(previous.payload);
    sources.set(identity(packet), packet);
  };
  for (const packet of packets) {
    expect([codecs.opus, codecs.red], "wire payload type is negotiated").toContain(packet.payloadType);
    if (packet.padding && packet.payload === "") {
      expect(packet.paddingSize, "padding-only RTP has a nonzero padding size").toBeGreaterThan(0);
      padding++;
      continue;
    }
    const decoded = packet.payloadType === codecs.red ? decodeRED(packet.payload) : {
      primary: { payloadType: packet.payloadType, payload: packet.payload, offset: 0 }, redundant: [],
    };
    expect(decoded.primary.payloadType).toBe(codecs.opus);
    const source = { ...content(packet), payloadType: codecs.opus, payload: decoded.primary.payload };
    if (authoritative) {
      expect(source, "wire primary matches Pion source bytes and RTP identity")
        .toEqual(authoritative.find(packet => identity(packet) === identity(source)));
    }
    primary.set(identity(source), source);
    add(source);
    if (!first.has(packet.ssrc)) first.set(packet.ssrc, source);
    if (packet.payloadType === codecs.red) depths.push(decoded.redundant.length);
    carriers.push({ packet, blocks: decoded.redundant });
  }
  // Resolve copies using independently observed primaries. RTP padding consumes
  // sequence numbers, so a copy need not be the immediately preceding RTP packet.
  for (const { packet, blocks } of carriers) {
    blocks.forEach((block, index) => {
      expect(block.payloadType, "redundant block protects Opus").toBe(codecs.opus);
      expect(block.offset, "redundant block carries earlier audio").toBeGreaterThan(0);
      expect(block.payload.length, "redundant Opus bytes").toBeGreaterThan(0);
      const timestamp = (packet.timestamp - block.offset) >>> 0;
      const candidates = (authoritative ?? Array.from(primary.values())).filter(source =>
        source.ssrc === packet.ssrc && source.timestamp === timestamp);
      if (candidates.length) {
        const source = candidates.find(source => source.payload === block.payload);
        expect(source, "redundancy exactly copies known source bytes").toBeDefined();
        add(source!);
        knownCopies++;
        return;
      }
      expect(Boolean(authoritative) || options.inferStartup === false, "missing independent sequence identity for redundant audio").toBe(false);
      // Only startup copies can precede this no-loss observation window. Their
      // sequence identity uses the receiver's documented contiguous-copy contract.
      const origin = first.get(packet.ssrc)!;
      expect((timestamp - origin.timestamp) | 0, "unseen copy precedes first observed primary").toBeLessThan(0);
      const sequenceNumber = (packet.sequenceNumber - blocks.length + index) & 0xffff;
      expect((sequenceNumber - origin.sequenceNumber + 0x8000 & 0xffff) - 0x8000,
        "inferred startup sequence precedes observed primaries").toBeLessThan(0);
      const copy = { ...content(packet), payloadType: codecs.opus, payload: block.payload, sequenceNumber, timestamp };
      add(copy);
      inferredCopies++;
    });
  }
  expect(depths.length, "actual wire RED carriers").toBeGreaterThan(5);
  expect(knownCopies, "useful verified redundancy").toBeGreaterThan(5);
  return { sources, primary, depths, copies: knownCopies, inferredCopies, padding };
}
