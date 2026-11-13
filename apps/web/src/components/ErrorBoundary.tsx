import { Component, type ReactNode } from 'react';

/** Last line of defence: a render crash shows a recovery screen instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    console.error('UI crash:', error);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="boot" role="alert">
        <h2>Something went wrong</h2>
        <p>Your data is safe. Reloading usually fixes this.</p>
        <button className="btn btn-primary" onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}
