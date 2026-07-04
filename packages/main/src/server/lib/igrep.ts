export type IgrepTextField = {
  name: string;
  text: string;
  weight?: number;
};

export type IgrepCandidate<T> = {
  item: T;
  fields: IgrepTextField[];
};

export type IgrepMatch<T> = {
  item: T;
  score: number;
  matchedFields: string[];
};

export function igrep<T>(
  query: string,
  candidates: Array<IgrepCandidate<T>>,
  options: { minScore?: number; limit?: number } = {},
): Array<IgrepMatch<T>> {
  const queryTokens = tokenize(query);
  if (queryTokens.size === 0) return [];
  const normalizedQuery = normalizeText(query);
  const minScore = options.minScore ?? 2;
  const matches: Array<IgrepMatch<T>> = [];

  for (const candidate of candidates) {
    let score = 0;
    const matchedFields = new Set<string>();

    for (const field of candidate.fields) {
      const text = field.text.trim();
      if (!text) continue;
      const weight = field.weight ?? 1;
      const fieldTokens = tokenize(text);
      let tokenHits = 0;
      for (const token of queryTokens) {
        if (fieldTokens.has(token)) tokenHits += 1;
      }
      if (tokenHits > 0) {
        score += tokenHits * weight;
        matchedFields.add(field.name);
      }

      const normalizedField = normalizeText(text);
      if (normalizedQuery.length >= 5 && normalizedField.includes(normalizedQuery)) {
        score += 3 * weight;
        matchedFields.add(field.name);
      }
    }

    const normalizedScore = score / Math.max(1, Math.sqrt(queryTokens.size));
    if (normalizedScore >= minScore) {
      matches.push({
        item: candidate.item,
        score: Number(normalizedScore.toFixed(3)),
        matchedFields: [...matchedFields],
      });
    }
  }

  return matches
    .sort((left, right) => right.score - left.score)
    .slice(0, options.limit ?? matches.length);
}

export function tokenize(value: string): Set<string> {
  const tokens = new Set<string>();
  const chunks = normalizeText(value).match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const chunk of chunks) {
    if (!chunk) continue;
    tokens.add(chunk);
    if (containsCjk(chunk)) {
      for (const char of [...chunk]) tokens.add(char);
      const chars = [...chunk];
      for (let index = 0; index < chars.length - 1; index += 1) {
        tokens.add(`${chars[index]}${chars[index + 1]}`);
      }
    }
  }
  return tokens;
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function containsCjk(value: string) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value);
}
