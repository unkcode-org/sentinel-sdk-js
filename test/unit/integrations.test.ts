import { beforeEach, describe, expect, it, vi } from "vitest";

const vitalCallbacks = vi.hoisted(() => new Map<string, (metric: unknown) => void>());

vi.mock("web-vitals", () => ({
  onCLS: (callback: (metric: unknown) => void) => vitalCallbacks.set("CLS", callback),
  onFCP: (callback: (metric: unknown) => void) => vitalCallbacks.set("FCP", callback),
  onINP: (callback: (metric: unknown) => void) => vitalCallbacks.set("INP", callback),
  onLCP: (callback: (metric: unknown) => void) => vitalCallbacks.set("LCP", callback),
  onTTFB: (callback: (metric: unknown) => void) => vitalCallbacks.set("TTFB", callback),
}));

import type { Sentinel } from "../../src/sentinel";
import { SentinelErrorBoundary } from "../../src/react";
import { instrumentWebVitals } from "../../src/web-vitals";

describe("optional integrations", () => {
  beforeEach(() => vitalCallbacks.clear());

  it("maps every Web Vital to the Sentinel metric API", () => {
    const histogram = vi.fn();
    const sentinel = { histogram } as unknown as Sentinel;

    instrumentWebVitals(sentinel, { reportAllChanges: true });
    expect([...vitalCallbacks.keys()].sort()).toEqual([
      "CLS",
      "FCP",
      "INP",
      "LCP",
      "TTFB",
    ]);

    vitalCallbacks.get("LCP")?.({
      name: "LCP",
      value: 123.4,
      delta: 10,
      id: "v1-test",
      rating: "good",
      navigationType: "navigate",
    });
    expect(histogram).toHaveBeenCalledWith("web_vitals.lcp", 123.4, {
      "web_vital.rating": "good",
      "web_vital.navigation_type": "navigate",
    });
  });

  it("routes React boundary errors through Sentinel", () => {
    const captureException = vi.fn();
    const boundary = new SentinelErrorBoundary({
      sentinel: { captureException } as unknown as Sentinel,
      children: "child",
    });
    const error = new Error("render failed");

    boundary.componentDidCatch(error, { componentStack: "\n at Component" });

    expect(captureException).toHaveBeenCalledWith(error, {
      "react.component_stack": "\n at Component",
    });
  });
});
