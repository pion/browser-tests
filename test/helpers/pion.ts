/**
* SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
* SPDX-License-Identifier: MIT
*/

const DEFAULT_SERVER_URL = "http://127.0.0.1:38481";

export const getServerUrl = () =>
  import.meta.env.VITE_TEST_SERVER_URL ?? DEFAULT_SERVER_URL;

export const waitForIceGatheringComplete = async (
  pc: RTCPeerConnection,
  timeoutMs = 10_000,
) => {
  if (pc.iceGatheringState === "complete") {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const onChange = () => {
      if (pc.iceGatheringState !== "complete") {
        return;
      }
      if (timeout) {
        clearTimeout(timeout);
      }
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };

    timeout = setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      reject(new Error("ICE gathering timeout"));
    }, timeoutMs);

    pc.addEventListener("icegatheringstatechange", onChange);
  });
};

export const waitForDataChannelOpen = async (
  channel: RTCDataChannel,
  timeoutMs = 10_000,
) => {
  if (channel.readyState === "open") {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      channel.removeEventListener("open", onOpen);
      channel.removeEventListener("error", onError);
    };

    const onOpen = () => {
      cleanup();
      resolve();
    };

    const onError = () => {
      cleanup();
      reject(new Error("Data channel open error"));
    };

    timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Data channel open timeout"));
    }, timeoutMs);

    channel.addEventListener("open", onOpen);
    channel.addEventListener("error", onError);
  });
};

export const waitForDataChannelMessage = async (
  channel: RTCDataChannel,
  timeoutMs = 10_000,
) => {
  return new Promise<string | ArrayBuffer>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      channel.removeEventListener("message", onMessage);
    };

    const onMessage = (event: MessageEvent) => {
      cleanup();
      resolve(event.data);
    };

    timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Data channel message timeout"));
    }, timeoutMs);

    channel.addEventListener("message", onMessage);
  });
};

export const exchangeOffer = async (
  offer: RTCSessionDescriptionInit,
  scenario = "hello",
) => {
  if (!offer.sdp) {
    throw new Error("Offer SDP missing");
  }

  const response = await fetch(`${getServerUrl()}/offer`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sdp: offer.sdp,
      type: offer.type ?? "offer",
      scenario,
    }),
  });

  if (!response.ok) {
    throw new Error(`Offer exchange failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    sdp?: string;
    type?: "answer";
  };

  if (!data.sdp) {
    throw new Error("Answer SDP missing");
  }

  return {
    type: data.type ?? "answer",
    sdp: data.sdp,
  } satisfies RTCSessionDescriptionInit;
};
