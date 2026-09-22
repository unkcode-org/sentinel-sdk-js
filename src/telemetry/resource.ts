import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

import type { NormalizedSentinelConfig } from "../config";

export function createResource(config: NormalizedSentinelConfig) {
  return defaultResource().merge(
    resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.serviceName,
      ...(config.release ? { [ATTR_SERVICE_VERSION]: config.release } : {}),
      ...(config.environment
        ? { [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.environment }
        : {}),
      "sentinel.sdk.name": "@unkcode/sentinel",
      "sentinel.sdk.version": "0.1.0",
    }),
  );
}
