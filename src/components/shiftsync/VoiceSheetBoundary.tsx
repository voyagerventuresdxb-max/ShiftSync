import { Component, type ReactNode } from 'react';

/**
 * Keeps an error while drawing the confirm sheet inside the voice sheet: the sheet closes with a
 * message instead of the router's error page replacing the whole app.
 */
export class VoiceSheetBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
