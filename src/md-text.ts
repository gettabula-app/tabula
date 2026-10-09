// User text inside generated Markdown (the session summary, poll results): one line that reads as typed.

/**
 * User text as one line of Markdown that reads as typed: line breaks (NEL and the Unicode separators too) fold to a space,
 * the characters that start emphasis, code, links, images, HTML, tables or a character reference are escaped, and so is a
 * leading `#`, `>`, `-`, `+` or `1.` that would make a block of a bullet's text.
 */
export function mdText(t: string | undefined): string {
  return (t ?? '').replace(/[\s\u0085\u2028\u2029]+/g, ' ').trim().replace(/[\\`*_[\]<>|~&]/g, '\\$&').replace(/^(#|>|-|\+)/, '\\$1').replace(/^(\d+)([.)])/, '$1\\$2');
}
