/** A selectable tool has a toolKind; action choices such as Link are restorable but have none. */
export interface RailToolChoice {
  id: string;
  toolKind?: string;
}

export function choiceForToolKind(kind: string, choices: readonly RailToolChoice[]): string | null {
  return choices.find((choice) => choice.toolKind === kind)?.id ?? null;
}

function hasChoice(id: string, choices: readonly RailToolChoice[]): boolean {
  return choices.some((choice) => choice.id === id);
}

/** Restore a saved choice, or use the active grouped tool, then the configured default. */
export function restoreToolChoice(
  saved: string | null,
  activeKind: string,
  choices: readonly RailToolChoice[],
  fallback: string,
): string {
  if (saved && hasChoice(saved, choices)) return saved;
  return choiceForToolKind(activeKind, choices) ?? (hasChoice(fallback, choices) ? fallback : choices[0]?.id ?? fallback);
}

/** Remember a newly active grouped tool while leaving the choice alone for unrelated tools. */
export function rememberToolChoice(
  current: string,
  activeKind: string,
  choices: readonly RailToolChoice[],
): string {
  return choiceForToolKind(activeKind, choices) ?? (hasChoice(current, choices) ? current : choices[0]?.id ?? current);
}
