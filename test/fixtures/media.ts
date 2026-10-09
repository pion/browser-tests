/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
export async function mediaSource(kind: "audio" | "video") {
  if (kind === "audio") {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return { stream, close: async () => {
      stream.getTracks().forEach(track => track.stop());
    } };
  }
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 240;
  const context = canvas.getContext("2d")!;
  let frame = 0;
  const paint = () => {
    context.fillStyle = `hsl(${frame++ * 10 % 360}, 100%, 50%)`;
    context.fillRect(0, 0, canvas.width, canvas.height);
  };
  paint();
  const stream = canvas.captureStream(15);
  const timer = setInterval(paint, 60);
  return { stream, close: async () => {
    clearInterval(timer);
    stream.getTracks().forEach(track => track.stop());
  } };
}

const contextState = (context: AudioContext) => ({ state: context.state, currentTime: context.currentTime,
  sampleRate: context.sampleRate, baseLatency: context.baseLatency, outputLatency: context.outputLatency });
const trackState = (track: MediaStreamTrack | undefined) => track &&
  ({ enabled: track.enabled, muted: track.muted, readyState: track.readyState });

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
  await context.resume();
  return { stream: destination.stream,
    diagnostics: () => ({ context: contextState(context), track: trackState(destination.stream.getAudioTracks()[0]) }),
    close: async () => {
    oscillator.stop();
    destination.stream.getTracks().forEach(track => track.stop());
    await context.close();
  } };
}

// Muted playback keeps remote audio flowing while an analyser measures the tone.
export async function audioSink(browser: RTCPeerConnection) {
  const context = new AudioContext();
  const sink = document.createElement("video");
  sink.autoplay = true;
  sink.playsInline = true;
  sink.muted = true;
  document.body.append(sink);
  const analyser = context.createAnalyser();
  const output = context.createGain();
  output.gain.value = 0;
  analyser.connect(output).connect(context.destination);
  let receivedTrack = false;
  let remoteTrack: MediaStreamTrack | undefined;
  const receive = ({ track }: RTCTrackEvent) => {
    if (track.kind !== "audio") return;
    const stream = new MediaStream([track]);
    sink.srcObject = stream;
    context.createMediaStreamSource(stream).connect(analyser);
    remoteTrack = track;
    receivedTrack = true;
  };
  browser.addEventListener("track", receive);
  await context.resume();
  const waveform = new Float32Array(analyser.fftSize);
  return {
    receivedTrack: () => receivedTrack,
    diagnostics: () => ({ context: contextState(context), track: trackState(remoteTrack),
      paused: sink.paused, readyState: sink.readyState, visibility: document.visibilityState }),
    rms: () => {
      analyser.getFloatTimeDomainData(waveform);
      return Math.sqrt(waveform.reduce((sum, sample) => sum + sample * sample, 0) / waveform.length);
    },
    close: async () => {
      browser.removeEventListener("track", receive);
      sink.pause();
      sink.srcObject = null;
      sink.remove();
      await context.close();
    },
  };
}
