/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
import { userEvent } from "vitest/browser";

async function resumeAudio(context: AudioContext) {
  if (context.state === "running") return;
  // Safari needs a trusted gesture for generated audio. Keep this local to
  // audio fixtures instead of overriding the browser's media policies.
  const start = document.createElement("button");
  start.textContent = "Start test audio";
  document.body.append(start);
  const resumed = new Promise<void>((resolve, reject) => {
    start.onclick = () => { void context.resume().then(resolve, reject); };
  });
  void resumed.catch(() => {});
  try {
    await userEvent.click(start);
    await resumed;
  } finally {
    start.onclick = null;
    start.remove();
  }
}

export async function mediaSource(kind: "audio" | "video") {
  // Use the browser's mock capture devices for both kinds of media. This
  // avoids depending on canvas rendering to drive the video transport tests.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: kind === "audio",
    video: kind === "video" ? { width: 320, height: 240, frameRate: 15 } : false,
  });
  return { stream, close: async () => {
    stream.getTracks().forEach(track => track.stop());
  } };
}

// A known non-silent source independent of fake microphone settings.
export async function oscillatorSource(frequency = 440) {
  const context = new AudioContext({ sampleRate: 48000 });
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const destination = context.createMediaStreamDestination();
  oscillator.frequency.value = frequency;
  gain.gain.value = 0.2;
  oscillator.connect(gain).connect(destination);
  oscillator.start();
  const close = async () => {
    oscillator.stop();
    destination.stream.getTracks().forEach(track => track.stop());
    await context.close();
  };
  try {
    await resumeAudio(context);
    return { stream: destination.stream, close };
  } catch (error) {
    await close();
    throw error;
  }
}

// Each track has its own muted playback and analyser so silent tracks cannot
// be masked by another stream's audio.
export async function audioSink(browser: RTCPeerConnection) {
  const context = new AudioContext();
  const sinks = new Map<string, { element: HTMLVideoElement; rms: () => number }>();
  const output = context.createGain();
  output.gain.value = 0;
  output.connect(context.destination);
  const receive = ({ track }: RTCTrackEvent) => {
    if (track.kind !== "audio") return;
    const element = document.createElement("video");
    element.autoplay = element.playsInline = element.muted = true;
    const stream = new MediaStream([track]);
    element.srcObject = stream;
    document.body.append(element);
    const analyser = context.createAnalyser();
    context.createMediaStreamSource(stream).connect(analyser).connect(output);
    const waveform = new Float32Array(analyser.fftSize);
    sinks.set(track.id, { element, rms: () => {
      analyser.getFloatTimeDomainData(waveform);
      return Math.sqrt(waveform.reduce((sum, sample) => sum + sample * sample, 0) / waveform.length);
    } });
  };
  browser.addEventListener("track", receive);
  try {
    await resumeAudio(context);
  } catch (error) {
    browser.removeEventListener("track", receive);
    await context.close();
    throw error;
  }
  return {
    sinks,
    receivedTrack: () => sinks.size > 0,
    rms: () => sinks.size ? Math.min(...Array.from(sinks.values(), sink => sink.rms())) : 0,
    close: async () => {
      browser.removeEventListener("track", receive);
      for (const { element } of sinks.values()) {
        element.pause();
        element.srcObject = null;
        element.remove();
      }
      sinks.clear();
      await context.close();
    },
  };
}
