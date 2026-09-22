import type { ErrorInfo, ReactNode } from "react";
import { Component } from "react";

import type { Sentinel } from "../sentinel";

export interface SentinelErrorBoundaryProps {
  readonly sentinel: Sentinel;
  readonly children: ReactNode;
  readonly fallback?: ReactNode;
}

interface SentinelErrorBoundaryState {
  readonly failed: boolean;
}

export class SentinelErrorBoundary extends Component<
  SentinelErrorBoundaryProps,
  SentinelErrorBoundaryState
> {
  override state: SentinelErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): SentinelErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.sentinel.captureException(error, {
      "react.component_stack": info.componentStack ?? "",
    });
  }

  override render(): ReactNode {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}
