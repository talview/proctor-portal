import { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

interface Props { children: ReactNode; }
interface State { hasError: boolean; error: Error | null; }

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-bg p-6">
          <div className="bg-surface border border-border rounded-2xl p-8 max-w-md w-full text-center">
            <AlertTriangle className="w-12 h-12 text-warning mx-auto mb-4" />
            <h1 className="text-xl font-bold text-text mb-2">Something went wrong</h1>
            <p className="text-text2 text-sm mb-4">{this.state.error?.message || 'An unexpected error occurred.'}</p>
            <button
              type="button"
              onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }}
              className="bg-accent hover:bg-accent/90 text-white font-semibold px-5 py-2.5 rounded-md text-sm transition-colors"
            >
              Reload Page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
