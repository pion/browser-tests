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
    close: async () => {
    oscillator.stop();
    destination.stream.getTracks().forEach(track => track.stop());
    await context.close();
  } };
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
  await context.resume();
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
