import { describe, it, expect } from "vitest";

describe("Browser Hello World", () => {
  it("should execute JavaScript in the browser", () => {
    expect("Hello from browser!").toBe("Hello from browser!");
  });

  it("should access browser APIs", () => {
    expect(typeof navigator.userAgent).toBe("string");
    expect(navigator.userAgent.length).toBeGreaterThan(0);
  });

  it("should verify RTCPeerConnection exists", () => {
    expect(typeof RTCPeerConnection).toBe("function");
  });

  it("should create an RTCPeerConnection", async () => {
    const pc = new RTCPeerConnection();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    expect(pc.localDescription?.type).toBe("offer");
    pc.close();
  });
});
