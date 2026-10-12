import { Component, type ReactNode } from 'react';

export class FeatureErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  render() {
    if (this.state.failed) return <div role="alert" className="status-line">
      <p>A new version is available.</p>
      <button className="btn" onClick={() => window.location.reload()}>Reload</button>
    </div>;
    return this.props.children;
  }
}
