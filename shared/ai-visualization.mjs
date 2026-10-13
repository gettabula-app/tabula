// Generated visualizations are untrusted code. These bounds protect the relay and renderer from malformed output;
// execution is confined separately to the visualization sandbox. None of this data belongs in a board document.

export const VISUALIZATION_LIMITS = Object.freeze({
  title: 100,
  description: 500,
  heightMin: 240,
  heightMax: 1000,
  css: 20_000,
  html: 30_000,
  js: 30_000,
  expressions: 16,
  total: 80_000,
});

const FIELDS = ['title', 'description', 'initialHeight', 'css', 'html', 'jsFunctions', 'jsExpressions'];
const boundedText = (value, max, required = false) => typeof value === 'string' && value.length <= max && (!required || value.trim().length > 0);

/** The exact, bounded artifact shape understood by both the relay and the isolated renderer. */
export function isVisualization(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.keys(value).length !== FIELDS.length || FIELDS.some((field) => !Object.hasOwn(value, field))) return false;
  if (!boundedText(value.title, VISUALIZATION_LIMITS.title, true) || !boundedText(value.description, VISUALIZATION_LIMITS.description)) return false;
  if (!Number.isInteger(value.initialHeight) || value.initialHeight < VISUALIZATION_LIMITS.heightMin || value.initialHeight > VISUALIZATION_LIMITS.heightMax) return false;
  if (!boundedText(value.css, VISUALIZATION_LIMITS.css) || !boundedText(value.html, VISUALIZATION_LIMITS.html, true) || !boundedText(value.jsFunctions, VISUALIZATION_LIMITS.js)) return false;
  if (!Array.isArray(value.jsExpressions) || value.jsExpressions.length > VISUALIZATION_LIMITS.expressions) return false;
  let js = value.jsFunctions.length;
  for (const expression of value.jsExpressions) {
    if (!boundedText(expression, VISUALIZATION_LIMITS.js)) return false;
    js += expression.length;
    if (js > VISUALIZATION_LIMITS.js) return false;
  }
  return value.css.length + value.html.length + js <= VISUALIZATION_LIMITS.total;
}
