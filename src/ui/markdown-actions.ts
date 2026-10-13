import { toast } from './common';

/** "Copy as Markdown": the source of a Markdown block goes to the clipboard exactly as it is written (docs/markdown-blocks.md). */
export function copyMarkdownSource(source: string): void {
  navigator.clipboard.writeText(source).then(() => toast('Markdown copied to the clipboard'), () => toast('Clipboard is not available'));
}
