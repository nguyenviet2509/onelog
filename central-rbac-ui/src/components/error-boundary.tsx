/**
 * components/error-boundary.tsx — Global React error boundary.
 * Catches render errors; shows retry button.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props { children: ReactNode }
interface State { hasError: boolean; message: string }

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: unknown): State {
    const message = error instanceof Error ? error.message : 'Lỗi không xác định';
    return { hasError: true, message };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info);
  }

  handleRetry = () => {
    this.setState({ hasError: false, message: '' });
  };

  override render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen flex-col items-center justify-center gap-4 text-center px-6">
          <p className="text-red-600 font-semibold text-lg">Đã xảy ra lỗi</p>
          <p className="text-gray-500 text-sm max-w-md">{this.state.message}</p>
          <button
            onClick={this.handleRetry}
            className="mt-2 px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700"
          >
            Thử lại
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
