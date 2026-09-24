/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { test as base, expect } from "vitest";

const timeoutMs = 10_000;
const serverURL = import.meta.env.VITE_TEST_SERVER_URL ?? "http://127.0.0.1:38481";

type Snapshot = {
  localDescription: RTCSessionDescriptionInit | null;
  remoteDescription: RTCSessionDescriptionInit | null;
  iceGatheringState: RTCIceGatheringState;
  connectionState: RTCPeerConnectionState;
  signalingState: RTCSignalingState;
  candidates: RTCIceCandidateInit[];
  states: string[];
};

export class PionPeer {
  readonly id: string;
  constructor(id: string) { this.id = id; }

  private async command<T>(operation: string, body: unknown = {}): Promise<T> {
    return request(`/peers/${this.id}/${operation}`, "POST", body);
  }

  createOffer(options: RTCOfferOptions = {}): Promise<RTCSessionDescriptionInit> {
    return this.command("create-offer", options);
  }
  createAnswer(): Promise<RTCSessionDescriptionInit> { return this.command("create-answer"); }
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    return this.command("set-local-description", description);
  }
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    return this.command("set-remote-description", description);
  }
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    return this.command("add-ice-candidate", candidate);
  }
  createDataChannel(label: string, options: RTCDataChannelInit = {}): Promise<void> {
    return this.command("create-data-channel", { label, options });
  }
  snapshot(): Promise<Snapshot> { return request(`/peers/${this.id}`); }
  close(): Promise<void> { return request(`/peers/${this.id}`, "DELETE"); }
}

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`${serverURL}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? undefined as T : response.json();
}

type Peer = RTCPeerConnection | PionPeer;

export class Interop {
  private browsers: RTCPeerConnection[] = [];
  private pions: PionPeer[] = [];
  private abort = new AbortController();
  private history = new Map<RTCPeerConnection, string[]>();

  browserPeer(configuration: RTCConfiguration = {}): RTCPeerConnection {
    const pc = new RTCPeerConnection(configuration);
    this.browsers.push(pc);
    const events: string[] = [];
    this.history.set(pc, events);
    for (const event of ["connectionstatechange", "iceconnectionstatechange", "signalingstatechange"]) {
      pc.addEventListener(event, () => events.push(`${event}: ${pc.connectionState}/${pc.iceConnectionState}/${pc.signalingState}`), { signal: this.abort.signal });
    }
    return pc;
  }

  async pionPeer(options: { behavior?: string; configuration?: RTCConfiguration } = {}): Promise<PionPeer> {
    const { id } = await request<{ id: string }>("/peers", "POST", options);
    const peer = new PionPeer(id);
    this.pions.push(peer);
    return peer;
  }

  // Attach listeners before triggering the operation being observed.
  event<T extends Event>(target: EventTarget, name: string): Promise<T> {
    const pending = new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        target.removeEventListener(name, receive);
        this.abort.signal.removeEventListener("abort", cancel);
      };
      const receive = (event: Event) => { cleanup(); resolve(event as T); };
      const cancel = () => { cleanup(); reject(new Error(`Cancelled waiting for ${name}`)); };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${name}`)); }, timeoutMs);
      target.addEventListener(name, receive);
      this.abort.signal.addEventListener("abort", cancel, { once: true });
      if (this.abort.signal.aborted) cancel();
    });
    // A failed setup may leave an event promise unawaited; teardown still cancels it.
    void pending.catch(() => {});
    return pending;
  }

  nextMessage(channel: RTCDataChannel): Promise<string | ArrayBuffer | Blob> {
    const pending = this.event<MessageEvent<string | ArrayBuffer | Blob>>(channel, "message").then(event => event.data);
    void pending.catch(() => {});
    return pending;
  }

  async waitForOpen(channel: RTCDataChannel): Promise<void> {
    if (channel.readyState === "open") return;
    if (channel.readyState === "closed") throw new Error("Data channel is closed");
    await this.event(channel, "open");
  }

  async localDescription(peer: Peer): Promise<RTCSessionDescriptionInit> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.abort.signal.aborted) throw new Error("Fixture closed");
      const state = peer instanceof PionPeer ? await peer.snapshot() : peer;
      if (state.iceGatheringState === "complete" && state.localDescription) return state.localDescription;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Timed out gathering ICE candidates");
  }

  // Optional non-trickle signaling; both arguments can be browser or Pion peers.
  async negotiate(offerer: Peer, answerer: Peer, options: RTCOfferOptions = {}): Promise<void> {
    await offerer.setLocalDescription(await offerer.createOffer(options));
    await answerer.setRemoteDescription(await this.localDescription(offerer));
    await answerer.setLocalDescription(await answerer.createAnswer());
    await offerer.setRemoteDescription(await this.localDescription(answerer));
  }

  async openDataChannel(options: RTCDataChannelInit = {}): Promise<RTCDataChannel> {
    const browser = this.browserPeer();
    const pion = await this.pionPeer({ behavior: "datachannel-echo" });
    const channel = browser.createDataChannel("echo", options);
    await this.negotiate(browser, pion);
    await this.waitForOpen(channel);
    return channel;
  }

  async diagnostics(): Promise<unknown> {
    return {
      browsers: this.browsers.map(pc => ({
        localDescription: pc.localDescription, remoteDescription: pc.remoteDescription,
        states: this.history.get(pc),
      })),
      pions: await Promise.all(this.pions.map(async peer => ({ id: peer.id, snapshot: await peer.snapshot().catch(String) }))),
    };
  }

  async close(): Promise<void> {
    this.abort.abort();
    this.browsers.forEach(pc => pc.close());
    const results = await Promise.allSettled(this.pions.map(peer => peer.close()));
    const failures = results.filter(result => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Pion cleanup failed");
  }
}

export const test = base.extend<{ interop: Interop }>({
  interop: async ({ task }, use) => {
    const interop = new Interop();
    try {
      await use(interop);
    } finally {
      try {
        if (task.result?.state === "fail") console.error("Interop diagnostics", JSON.stringify(await interop.diagnostics(), null, 2));
      } finally {
        await interop.close();
      }
    }
  },
});
export { expect };
