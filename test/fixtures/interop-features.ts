/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */

import { FeatureDetector, type FeatureSupport } from "./features";

export function interopFeatures(loadPionFeatures: () => Promise<Record<string, FeatureSupport>>) {
  return new FeatureDetector({
    "pion.dtlsRestart": async () => {
      const features = await loadPionFeatures();
      return features.dtlsRestart ?? { supported: false, reason: "Server does not advertise dtlsRestart" };
    },
    "pion.flexfecMultiFrame": async () => {
      const features = await loadPionFeatures();
      return features.flexfecMultiFrame ?? { supported: false, reason: "Server does not advertise flexfecMultiFrame" };
    },
    "browser.flexfecReceive": async () => {
      const codecs = RTCRtpReceiver.getCapabilities("video")?.codecs ?? [];
      return codecs.some(codec => codec.mimeType.toLowerCase() === "video/flexfec-03")
        ? { supported: true }
        : { supported: false, reason: "Browser cannot receive video/flexfec-03" };
    },
    "browser.dtlsRestart": async () => {
      const offerer = new RTCPeerConnection();
      const answerer = new RTCPeerConnection();
      const replacement = new RTCPeerConnection();
      const waitFor = async (ready: () => boolean) => {
        const deadline = Date.now() + 5_000;
        while (!ready()) {
          if (Date.now() >= deadline) return false;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        return true;
      };
      const negotiate = async (peer: RTCPeerConnection) => {
        await peer.setLocalDescription(await peer.createOffer());
        if (!await waitFor(() => peer.iceGatheringState === "complete")) {
          throw new Error("Browser restart probe timed out gathering offer candidates");
        }
        await answerer.setRemoteDescription(peer.localDescription!);
        await answerer.setLocalDescription(await answerer.createAnswer());
        if (!await waitFor(() => answerer.iceGatheringState === "complete")) {
          throw new Error("Browser restart probe timed out gathering answer candidates");
        }
        await peer.setRemoteDescription(answerer.localDescription!);
      };
      const echo = async (channel: RTCDataChannel, message: string) => {
        if (!await waitFor(() => channel.readyState === "open")) return false;
        let received = false;
        channel.onmessage = event => { received = event.data === message; };
        channel.send(message);
        return waitFor(() => received);
      };
      try {
        const options = { negotiated: true, id: 0 };
        const original = offerer.createDataChannel("feature-probe", options);
        const preserved = answerer.createDataChannel("feature-probe", options);
        preserved.onmessage = event => preserved.send(event.data);
        await negotiate(offerer);
        if (!await echo(original, "before restart")) {
          throw new Error("Browser restart probe could not establish its initial data channel");
        }

        const transport = answerer.sctp!.transport;
        let restarting = false;
        transport.addEventListener("statechange", () => {
          if (transport.state === "new" || transport.state === "connecting") restarting = true;
        });
        replacement.createDataChannel("feature-probe", options);
        await negotiate(replacement);
        if (await waitFor(() => restarting)) return { supported: true };
        return { supported: false, reason: "Browser accepted the new fingerprint without restarting its established DTLS transport" };
      } catch (error) {
        if (!(error instanceof DOMException) ||
            !["NotSupportedError", "InvalidAccessError", "OperationError"].includes(error.name)) throw error;
        return { supported: false, reason: `Browser rejected fingerprint renegotiation: ${error.message}` };
      } finally {
        offerer.close();
        answerer.close();
        replacement.close();
      }
    },
  });
}
