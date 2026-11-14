import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, errorInfo: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });
    console.error('[ErrorBoundary]', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
    this.props.onReset?.();
  };

  handleHome = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
    window.location.hash = '#/';
    window.location.pathname = '/';
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
          <div className="w-12 h-12 rounded-full bg-accent-red/15 flex items-center justify-center mb-4">
            <AlertTriangle className="w-6 h-6 text-accent-red" />
          </div>
          <h2 className="text-lg font-semibold text-text-primary mb-1">
            {this.props.fallbackTitle || 'Something went wrong'}
          </h2>
          <p className="text-xs text-text-secondary max-w-md mb-2">
            This page hit an unexpected error. You can retry or return to the dashboard.
          </p>
          {this.state.error && (
            <pre className="text-[10px] text-accent-red/80 bg-white/5 border border-white/10 rounded-md px-3 py-2 max-w-lg overflow-auto mb-4 text-left">
              {this.state.error.message}
            </pre>
          )}
          <div className="flex gap-2">
            <button
              onClick={this.handleReset}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-accent-sky text-void text-xs font-semibold hover:bg-accent-sky/90"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Retry
            </button>
            <button
              onClick={this.handleHome}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-white/15 text-text-secondary text-xs font-semibold hover:bg-white/5"
            >
              <Home className="w-3.5 h-3.5" />
              Dashboard
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Functional wrapper for route-level use with Suspense */
export function RouteErrorBoundary({ children, title }: { children: ReactNode; title?: string }) {
  return <ErrorBoundary fallbackTitle={title}>{children}</ErrorBoundary>;
}
