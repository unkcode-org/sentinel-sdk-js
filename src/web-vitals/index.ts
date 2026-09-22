import type { Sentinel } from "../sentinel";
import {
  onCLS,
  onFCP,
  onINP,
  onLCP,
  onTTFB,
} from "web-vitals";
import type { Metric } from "web-vitals";

export interface WebVitalsOptions {
  readonly reportAllChanges?: boolean;
}

export function instrumentWebVitals(
  sentinel: Sentinel,
  options: WebVitalsOptions = {},
): void {
  const onMetric = (metric: Metric) => {
    sentinel.histogram(`web_vitals.${metric.name.toLowerCase()}`, metric.value, {
      "web_vital.rating": metric.rating,
      "web_vital.navigation_type": metric.navigationType,
    });
  };
  const reportOptions = { reportAllChanges: options.reportAllChanges ?? false };
  onCLS(onMetric, reportOptions);
  onFCP(onMetric, reportOptions);
  onINP(onMetric, reportOptions);
  onLCP(onMetric, reportOptions);
  onTTFB(onMetric, reportOptions);
}
