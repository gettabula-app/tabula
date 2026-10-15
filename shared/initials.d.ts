// Types for shared/initials.mjs. The browser imports it without an extension ('../shared/initials'); the server imports
// 'initials.mjs' directly.

/** The user-perceived characters of `text`: grapheme clusters, or code points where Intl.Segmenter is missing. */
export function graphemes(text: string | null | undefined): string[];
/** The first user-perceived character of `text`; '' when there is none. */
export function firstGrapheme(text: string): string;
/** The initial a name is drawn with: its first character, upper case; '?' when the name is blank. */
export function initialOf(name: string | null | undefined): string;
/** The initials of the first two words ("Ana Lima Souza" gives "AL"); '' when the name is blank. */
export function wordInitials(name: string | null | undefined): string;
/** The initials of the first and the last word ("Ana Lima Souza" gives "AS"); '' when the name is blank. */
export function firstLastInitials(name: string | null | undefined): string;
