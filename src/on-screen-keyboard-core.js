// on-screen-keyboard-core.js
// Pure logic for the on-screen keyboard's word autocomplete ("autopredict"):
// a weighted keyword trie plus the two string ops the DOM shell needs —
// pull the identifier under the caret, and turn it into ranked completions.
// No DOM, no module state beyond the frozen keyword list, so it is unit
// tested directly (test/on-screen-keyboard-core.test.js) and the shell in
// on-screen-keyboard.js only has to wire events to it.

class TrieNode {
  constructor() { this.ch = Object.create(null); this.end = false; this.w = 0; }
}

export class Trie {
  constructor() { this.root = new TrieNode(); }

  insert(word, weight) {
    let n = this.root;
    for (const c of word) { if (!n.ch[c]) n.ch[c] = new TrieNode(); n = n.ch[c]; }
    n.end = true;
    n.w = Math.max(n.w, weight || 1);
  }

  // Every stored word that begins with `prefix`, most-weighted first, capped
  // at `limit`. An empty prefix predicts nothing (the shell shows no row).
  predict(prefix, limit = 5) {
    if (!prefix) return [];
    let n = this.root;
    for (const c of prefix) { if (!n.ch[c]) return []; n = n.ch[c]; }
    const out = [];
    (function dfs(node, s) {
      if (out.length >= limit * 4) return;
      if (node.end) out.push({ s, w: node.w });
      for (const c in node.ch) dfs(node.ch[c], s + c);
    })(n, prefix);
    return out.sort((a, b) => b.w - a.w).slice(0, limit).map((x) => x.s);
  }
}

// Strudel / Hydra vocabulary, roughly weighted by how often a live coder
// reaches for each. Kept as data so a test can assert against it and so it is
// obvious what the keyboard knows about.
export const KEYWORDS = [
  ['note', 10], ['n', 9], ['s', 10], ['sound', 7], ['stack', 9], ['cat', 7], ['seq', 6],
  ['chord', 7], ['scale', 6], ['arp', 5], ['gain', 9], ['cutoff', 7], ['resonance', 5],
  ['pan', 6], ['room', 6], ['size', 5], ['delay', 7], ['orbit', 5], ['slow', 8], ['fast', 8],
  ['rev', 7], ['jux', 6], ['add', 7], ['transpose', 6], ['speed', 5], ['every', 8],
  ['sometimes', 7], ['often', 6], ['rarely', 5], ['degradeBy', 5], ['struct', 5],
  ['euclid', 6], ['crush', 4], ['shape', 5], ['coarse', 4], ['vowel', 5], ['hcutoff', 4],
  ['begin', 5], ['end', 5], ['loop', 5], ['pitch', 5], ['silence', 5], ['rest', 5], ['live', 6],
  ['bd', 8], ['sd', 8], ['hh', 9], ['cp', 7], ['bass', 7], ['piano', 6], ['violin', 5],
  ['tabla', 4], ['crow', 4], ['jazz', 4], ['psr', 3],
  ['osc', 8], ['noise', 7], ['voronoi', 6], ['solid', 6], ['gradient', 5],
  ['out', 8], ['color', 7], ['colorama', 5], ['rotate', 6], ['pixelate', 5],
  ['kaleid', 5], ['invert', 6], ['contrast', 5], ['brightness', 5], ['saturate', 5],
  ['hue', 5], ['modulate', 6], ['blend', 6], ['diff', 5], ['mult', 5], ['luma', 5],
  ['thresh', 4], ['mask', 4], ['modulateScale', 3], ['modulateRotate', 3],
];

export function buildKeywordTrie() {
  const t = new Trie();
  for (const [w, wt] of KEYWORDS) t.insert(w, wt);
  return t;
}

export const KEYWORD_TRIE = buildKeywordTrie();

// The identifier the caret is sitting at the end of — what the user is
// currently typing. Trailing whitespace or punctuation means "not in a word",
// so nothing is being completed.
export function wordPrefixAt(text, caret) {
  const upto = String(text ?? '').slice(0, caret ?? (text ? text.length : 0));
  const m = upto.match(/[A-Za-z_$][A-Za-z0-9_$]*$/);
  return m ? m[0] : '';
}

// Ranked completions for whatever word the caret is in. The word itself is
// dropped — a suggestion identical to what is already typed completes nothing
// and just crowds the row.
export function predictCompletions(text, caret, { limit = 5, trie = KEYWORD_TRIE } = {}) {
  const prefix = wordPrefixAt(text, caret);
  if (!prefix) return [];
  return trie.predict(prefix, limit + 1).filter((w) => w !== prefix).slice(0, limit);
}
