import React from "react";
import { withTranslation, WithTranslation } from "react-i18next";
import Icon from "../common/Icon";

type Props = {
  children: React.ReactNode;
  /**
   * 表示スタイル。
   * - "panel": サイドパネル用のコンパクトなカード（幅はパネル任せ）
   * - "fill":  親要素全体を占めるセンター表示（ペイン領域など）
   */
  variant?: "panel" | "fill";
} & WithTranslation;

type State = { error: Error | null };

/**
 * 局所的なエラー境界。子ツリーの描画クラッシュを吸収して
 * インラインのエラーカード＋再試行ボタンに置き換える。
 * これが無いと 1 コンポーネントの例外でウィンドウ全体が真っ暗になる。
 */
class ErrorBoundaryInner extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    const { t, variant = "panel" } = this.props;
    if (!this.state.error) return this.props.children;

    return (
      <div
        className={
          variant === "fill"
            ? "flex-1 flex flex-col items-center justify-center gap-2 p-4 text-xs"
            : "flex flex-col items-center justify-center gap-2 p-4 text-xs w-72 flex-shrink-0 border-l"
        }
        style={{
          backgroundColor: "var(--kf-bg-primary)",
          borderColor: "var(--kf-border)",
          color: "var(--kf-text-muted)",
        }}
        role="alert"
      >
        <Icon name="error" size={22} style={{ color: "var(--kf-error)" }} />
        <span className="text-center">{t("errorBoundary.message")}</span>
        <span
          className="text-center break-all opacity-70"
          style={{ fontSize: 10, maxWidth: 260 }}
        >
          {this.state.error.message}
        </span>
        <button
          onClick={() => this.setState({ error: null })}
          className="flex items-center gap-1 px-2 py-1 rounded mt-1"
          style={{
            color: "var(--kf-accent-fg)",
            backgroundColor: "var(--kf-accent)",
          }}
        >
          <Icon name="refresh" size={13} />
          {t("errorBoundary.retry")}
        </button>
      </div>
    );
  }
}

const ErrorBoundary = withTranslation()(ErrorBoundaryInner);
export default ErrorBoundary;
