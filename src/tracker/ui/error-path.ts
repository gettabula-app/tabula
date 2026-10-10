/** Convert REST validation paths into the fields used by tracker controls. */
export function trackerErrorField(path: string | undefined): string | null {
  if (!path) return null;
  const field = path.replace(/^patch\./, '');
  return field === 'query' ? 'search' : field;
}
