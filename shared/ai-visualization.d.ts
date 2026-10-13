export interface Visualization {
  title: string;
  description: string;
  initialHeight: number;
  css: string;
  html: string;
  jsFunctions: string;
  jsExpressions: string[];
}

export const VISUALIZATION_LIMITS: Readonly<{
  title: number;
  description: number;
  heightMin: number;
  heightMax: number;
  css: number;
  html: number;
  js: number;
  expressions: number;
  total: number;
}>;

export function isVisualization(value: unknown): value is Visualization;
