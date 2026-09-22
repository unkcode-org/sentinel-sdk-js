import { context, propagation, trace } from "@opentelemetry/api";
import { ZoneContextManager } from "@opentelemetry/context-zone";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import type { WebTracerProvider } from "@opentelemetry/sdk-trace-web";

import { SentinelInitializationError } from "../config";

export interface GlobalRegistration {
  disable(): void;
}

export function registerGlobals(
  tracerProvider: WebTracerProvider,
): GlobalRegistration {
  const contextManager = new ZoneContextManager();
  contextManager.enable();
  if (!context.setGlobalContextManager(contextManager)) {
    contextManager.disable();
    throw new SentinelInitializationError(
      "A global OpenTelemetry context manager is already installed",
    );
  }

  const propagator = new W3CTraceContextPropagator();
  if (!propagation.setGlobalPropagator(propagator)) {
    context.disable();
    contextManager.disable();
    throw new SentinelInitializationError(
      "A global OpenTelemetry propagator is already installed",
    );
  }

  if (!trace.setGlobalTracerProvider(tracerProvider)) {
    propagation.disable();
    context.disable();
    contextManager.disable();
    throw new SentinelInitializationError(
      "A global OpenTelemetry tracer provider is already installed",
    );
  }

  let enabled = true;
  return {
    disable() {
      if (!enabled) return;
      enabled = false;
      trace.disable();
      propagation.disable();
      context.disable();
      contextManager.disable();
    },
  };
}
