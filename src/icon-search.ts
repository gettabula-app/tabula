// Ranking for the icon search. Pure: no DOM and no fetch. A set is searched through its index: names in browse order,
// aliases as [alias, index of the icon], and categories as lists of indexes.

export interface SearchSet {
  prefix: string;
  names: string[];
  aliases: [string, number][];
  categories?: Record<string, number[]>;
}

export interface SearchOptions {
  limit: number;
  /** At most this many results from one set. */
  perSet?: number;
  /** Called once for each indexed name or alias checked against the query. */
  onCandidateCheck?: () => void;
}

/** Lower-case words of a query. */
export const queryTokens = (query: string): string[] => query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** 0 for a whole word of the name, 1 for the start of a word, 2 for any other substring, -1 for no match. */
function wordScore(name: string, token: string): number {
  if (!name.includes(token)) return -1;
  const words = name.split(/[^a-z0-9]+/);
  if (words.includes(token)) return 0;
  return words.some((w) => w.startsWith(token)) ? 1 : 2;
}

/** Sum of the scores of every token, or -1 when one token does not match. */
function allScore(text: string, tokens: string[]): number {
  let sum = 0;
  for (const t of tokens) {
    const s = wordScore(text, t);
    if (s < 0) return -1;
    sum += s;
  }
  return sum;
}

interface Hit { index: number; tier: number; score: number }

const better = (a: Hit, b: Hit, names: string[]) => a.tier - b.tier || a.score - b.score || names[a.index].length - names[b.index].length || (names[a.index] < names[b.index] ? -1 : 1);

function setHits(set: SearchSet, tokens: string[], onCandidateCheck?: () => void): Hit[] {
  const best = new Map<number, Hit>();
  const offer = (hit: Hit) => {
    const have = best.get(hit.index);
    if (!have || better(hit, have, set.names) < 0) best.set(hit.index, hit);
  };
  set.names.forEach((name, index) => {
    onCandidateCheck?.();
    const score = allScore(name, tokens);
    if (score >= 0) offer({ index, tier: 0, score });
  });
  for (const [alias, index] of set.aliases) {
    onCandidateCheck?.();
    const score = allScore(alias, tokens);
    if (score >= 0) offer({ index, tier: 1, score });
  }
  if (set.categories) {
    const viaCategory = new Map<number, number[]>();
    for (const [category, indexes] of Object.entries(set.categories)) {
      const scores = tokens.map((t) => wordScore(category.toLowerCase(), t));
      if (scores.every((s) => s < 0)) continue;
      for (const index of indexes) {
        const seen = viaCategory.get(index) ?? tokens.map(() => -1);
        scores.forEach((s, i) => { if (s >= 0 && (seen[i] < 0 || s < seen[i])) seen[i] = s; });
        viaCategory.set(index, seen);
      }
    }
    for (const [index, fromCategory] of viaCategory) {
      let score = 0;
      for (let i = 0; i < tokens.length; i++) {
        const own = wordScore(set.names[index], tokens[i]);
        const s = own >= 0 ? own : fromCategory[i];
        if (s < 0) { score = -1; break; }
        score += s;
      }
      if (score >= 0) offer({ index, tier: 2, score });
    }
  }
  return [...best.values()];
}

/**
 * Searches sets in priority order and returns `prefix:name` for the best `limit` hits. Every query word must match.
 * A whole word beats the start of a word beats a substring; a match in the name beats one in an alias beats one in a
 * category; shorter names first; ties go to the set earlier in the list. An alias hit returns the icon's own name.
 */
export function searchSets(sets: SearchSet[], query: string, { limit, perSet, onCandidateCheck }: SearchOptions): string[] {
  const tokens = queryTokens(query);
  if (!tokens.length || limit <= 0) return [];
  const all: { hit: Hit; set: number }[] = [];
  sets.forEach((set, setIndex) => {
    let hits = setHits(set, tokens, onCandidateCheck);
    if (perSet !== undefined && hits.length > perSet) hits = hits.sort((a, b) => better(a, b, set.names)).slice(0, perSet);
    for (const hit of hits) all.push({ hit, set: setIndex });
  });
  all.sort((a, b) => a.hit.tier - b.hit.tier || a.hit.score - b.hit.score
    || sets[a.set].names[a.hit.index].length - sets[b.set].names[b.hit.index].length || a.set - b.set
    || (sets[a.set].names[a.hit.index] < sets[b.set].names[b.hit.index] ? -1 : 1));
  return all.slice(0, limit).map(({ hit, set }) => `${sets[set].prefix}:${sets[set].names[hit.index]}`);
}
