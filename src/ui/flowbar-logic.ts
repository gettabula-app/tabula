/** Touch wording for the instruction shown while a dot vote is running. */
export function voteInstructionText(desktopText: string, coarsePointer: boolean): string {
  return coarsePointer ? 'Tap an item to add a dot; switch on Remove dots to take one back.' : desktopText;
}

/** Keep the dot-count button's help in step with the input method. */
export function dotsButtonTip(coarsePointer: boolean): string {
  return coarsePointer
    ? 'Tap an item to add a dot; switch on Remove dots to take one back. Tap here to change how many dots each person gets.'
    : 'Click a note to add a dot, shift-click to remove one. Click here to change how many dots each person gets.';
}
