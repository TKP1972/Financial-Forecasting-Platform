import type { ForecastMethod } from '@ffp/shared';

/** One observation on the period axis. */
export interface HistoricalPoint {
  periodKey: string;
  value: number;
}

/** Goodness-of-fit measures. All are "lower is better" except `rSquared`. */
export interface AccuracyMetrics {
  /** Mean absolute error, in the units of the series. */
  mae: number;
  /** Root mean squared error - penalises large misses. */
  rmse: number;
  /** Mean absolute percentage error, as a fraction. `null` when any actual is 0. */
  mape: number | null;
  /** Symmetric MAPE - defined even when actuals touch zero. */
  smape: number;
  /**
   * Mean absolute scaled error. Scale-free and comparable across series:
   * < 1 means the model beats a naive forecast. The one metric to rank on.
   */
  mase: number | null;
  /** Mean error. Sign matters: persistent positive means the model under-forecasts. */
  bias: number;
  /** Bias as a fraction of mean actual, i.e. systematic over/under-budgeting. */
  biasPercent: number | null;
  /** Fraction of variance explained by the fitted values. */
  rSquared: number | null;
  /** Number of paired observations the metrics were computed over. */
  n: number;
}

export interface PredictionInterval {
  /** Confidence level, e.g. 0.95. */
  level: number;
  lower: number[];
  upper: number[];
}

export interface ForecastResult {
  method: ForecastMethod;
  /** Point forecasts, `horizon` long. */
  point: number[];
  /** Period keys the point forecasts belong to, when derivable from the input. */
  periodKeys: string[];
  /** In-sample one-step-ahead fitted values, aligned to the history. */
  fitted: (number | null)[];
  /** In-sample residuals (actual - fitted), nulls dropped. */
  residuals: number[];
  interval: PredictionInterval | null;
  /** Fitted or supplied parameters (alpha, beta, gamma, window, slope...). */
  parameters: Record<string, number>;
  /** Fit quality over the in-sample window. */
  accuracy: AccuracyMetrics;
  /** Anything a reviewer should know: short history, fallback applied, etc. */
  warnings: string[];
}

export interface ForecastOptions {
  horizon: number;
  seasonLength?: number;
  alpha?: number;
  beta?: number;
  gamma?: number;
  /** Damping parameter for Holt's trend. 1 = undamped. */
  phi?: number;
  window?: number;
  confidenceLevel?: number;
  /** Period keys to label the forecast with; generated when omitted. */
  futurePeriodKeys?: string[];
}

/** One candidate evaluated during automatic method selection. */
export interface BacktestScore {
  method: ForecastMethod;
  parameters: Record<string, number>;
  /** Out-of-sample accuracy across the backtest folds. */
  accuracy: AccuracyMetrics;
  /** Ranking value - MASE where available, otherwise RMSE. */
  score: number;
  foldCount: number;
  error?: string;
}

export interface AutoForecastResult extends ForecastResult {
  /** Every candidate considered, best first. Surfaced so the choice is auditable. */
  candidates: BacktestScore[];
  selectionCriterion: 'MASE' | 'RMSE';
}
