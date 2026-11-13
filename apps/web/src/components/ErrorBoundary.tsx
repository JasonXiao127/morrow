import { Component, type ErrorInfo, type ReactNode } from "react";
import { FatalError } from "./FatalError";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[morrow] render error", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <FatalError
          title="This page slipped away."
          description="A component failed to render. Reloading usually brings it back."
        />
      );
    }
    return this.props.children;
  }
}
