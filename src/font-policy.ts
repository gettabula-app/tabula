export interface FontEntry {
  name: string;
  slug: string;
  category: string;
  weights: number[];
  italic: boolean;
  variable: boolean;
  tags: string[];
}

/** The offline picker list, also the only Fontshare families used in the demo build. */
export const BUILTIN_FONTS: FontEntry[] = [
  { name: 'Satoshi', slug: 'satoshi', category: 'Sans', weights: [300, 400, 500, 700, 900], italic: true, variable: true, tags: [] },
  { name: 'General Sans', slug: 'general-sans', category: 'Sans', weights: [200, 300, 400, 500, 600, 700], italic: true, variable: true, tags: [] },
  { name: 'Cabinet Grotesk', slug: 'cabinet-grotesk', category: 'Sans', weights: [100, 200, 300, 400, 500, 700, 800, 900], italic: false, variable: true, tags: [] },
  { name: 'Switzer', slug: 'switzer', category: 'Sans', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], italic: true, variable: true, tags: [] },
  { name: 'Clash Display', slug: 'clash-display', category: 'Display', weights: [200, 300, 400, 500, 600, 700], italic: false, variable: true, tags: [] },
  { name: 'Gambetta', slug: 'gambetta', category: 'Serif', weights: [300, 400, 500, 600, 700], italic: true, variable: true, tags: [] },
  { name: 'Boska', slug: 'boska', category: 'Serif', weights: [200, 300, 400, 500, 700, 900], italic: true, variable: true, tags: [] },
  { name: 'Tabular', slug: 'tabular', category: 'Sans', weights: [300, 400, 500, 600, 700], italic: true, variable: true, tags: ['Code'] },
  { name: 'Comico', slug: 'comico', category: 'Handwritten', weights: [400], italic: false, variable: false, tags: [] },
];

export const DEMO_FONT_ALLOWLIST: ReadonlySet<string> = new Set(BUILTIN_FONTS.map((font) => font.slug));
