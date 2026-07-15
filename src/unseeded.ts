export type CountedValue = { value: string; count: number };

export type UnseededContext = {
  sentence_id: string;
  text: string;
  translation: string | null;
  collection: string | null;
  document: string | null;
  dialect: string | null;
  dialect_path: string | null;
  region: string | null;
  uri: string | null;
  source_slug: string | null;
};

export type UnseededWord = {
  rank: number;
  form: string;
  lookup_status: "unresolved" | "tagger_lemma_suggestion";
  canonical_candidates: CountedValue[];
  occurrences: number;
  collection_count: number;
  dialect_count: number;
  region_count: number;
  surfaces: string[];
  collections: string[];
  dialects: string[];
  dialect_paths: string[];
  regions: string[];
  tagger_lemmas: CountedValue[];
  tagger_pos: CountedValue[];
  review_disposition: string;
  suggested_parse: string;
  evidence: string;
  note: string;
  contexts: UnseededContext[];
};

export type UnseededSnapshot = {
  metadata: Record<string, string>;
  words: UnseededWord[];
  byForm: Map<string, UnseededWord>;
};

export type UnseededFilters = {
  q?: string | null;
  lookupStatus?: string | null;
  reviewDisposition?: string | null;
  region?: string | null;
  minCount?: number;
  minCollections?: number;
  limit?: number;
  offset?: number;
};

function parseLine(line: string): string[] {
  const fields: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (char === "\t" && !quoted) {
      fields.push(value);
      value = "";
    } else {
      value += char;
    }
  }
  if (quoted) throw new Error("unterminated quoted field in unseeded-word TSV");
  fields.push(value);
  return fields;
}

function jsonArray<T>(value: string): T[] {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("expected an array in unseeded-word TSV");
  return parsed as T[];
}

function integer(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid ${field} in unseeded-word TSV`);
  return parsed;
}

export function parseUnseededWords(tsv: string): UnseededSnapshot {
  const metadata: Record<string, string> = {};
  const dataLines: string[] = [];
  for (const line of tsv.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("# ")) {
      const colon = line.indexOf(":", 2);
      if (colon > 2) metadata[line.slice(2, colon).trim()] = line.slice(colon + 1).trim();
      continue;
    }
    dataLines.push(line);
  }
  if (!dataLines.length) return { metadata, words: [], byForm: new Map() };

  const header = parseLine(dataLines[0]);
  const field = new Map(header.map((name, index) => [name, index]));
  const required = [
    "rank", "form", "lookup_status", "canonical_candidates", "occurrences",
    "collection_count", "dialect_count", "region_count", "surfaces", "collections",
    "dialects", "dialect_paths", "regions", "tagger_lemmas", "tagger_pos",
    "review_disposition", "suggested_parse", "evidence", "note", "contexts",
  ];
  for (const name of required) if (!field.has(name)) throw new Error(`missing ${name} in unseeded-word TSV`);
  const get = (values: string[], name: string) => values[field.get(name)!] ?? "";

  const words = dataLines.slice(1).map((line): UnseededWord => {
    const values = parseLine(line);
    if (values.length !== header.length) throw new Error("unseeded-word TSV row has the wrong number of fields");
    const lookupStatus = get(values, "lookup_status");
    if (lookupStatus !== "unresolved" && lookupStatus !== "tagger_lemma_suggestion") {
      throw new Error(`invalid lookup_status in unseeded-word TSV: ${lookupStatus}`);
    }
    return {
      rank: integer(get(values, "rank"), "rank"),
      form: get(values, "form"),
      lookup_status: lookupStatus,
      canonical_candidates: jsonArray<CountedValue>(get(values, "canonical_candidates")),
      occurrences: integer(get(values, "occurrences"), "occurrences"),
      collection_count: integer(get(values, "collection_count"), "collection_count"),
      dialect_count: integer(get(values, "dialect_count"), "dialect_count"),
      region_count: integer(get(values, "region_count"), "region_count"),
      surfaces: jsonArray<string>(get(values, "surfaces")),
      collections: jsonArray<string>(get(values, "collections")),
      dialects: jsonArray<string>(get(values, "dialects")),
      dialect_paths: jsonArray<string>(get(values, "dialect_paths")),
      regions: jsonArray<string>(get(values, "regions")),
      tagger_lemmas: jsonArray<CountedValue>(get(values, "tagger_lemmas")),
      tagger_pos: jsonArray<CountedValue>(get(values, "tagger_pos")),
      review_disposition: get(values, "review_disposition"),
      suggested_parse: get(values, "suggested_parse"),
      evidence: get(values, "evidence"),
      note: get(values, "note"),
      contexts: jsonArray<UnseededContext>(get(values, "contexts")),
    };
  });
  const byForm = new Map(words.map((word) => [word.form, word]));
  if (byForm.size !== words.length) throw new Error("duplicate form in unseeded-word TSV");
  return { metadata, words, byForm };
}

function normalized(value: string | null | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase();
}

export function selectUnseededWords(snapshot: UnseededSnapshot, filters: UnseededFilters) {
  const query = normalized(filters.q);
  const lookupStatus = normalized(filters.lookupStatus);
  const disposition = normalized(filters.reviewDisposition);
  const region = normalized(filters.region);
  const minCount = Math.max(0, Math.trunc(filters.minCount ?? 0));
  const minCollections = Math.max(0, Math.trunc(filters.minCollections ?? 0));
  const offset = Math.max(0, Math.trunc(filters.offset ?? 0));
  const limit = Math.min(200, Math.max(1, Math.trunc(filters.limit ?? 50)));

  const matched = snapshot.words.filter((word) => {
    if (query && !normalized(word.form).includes(query) && !word.surfaces.some((surface) => normalized(surface).includes(query))) return false;
    if (lookupStatus && normalized(word.lookup_status) !== lookupStatus) return false;
    if (disposition && normalized(word.review_disposition) !== disposition) return false;
    if (region && !word.regions.some((value) => normalized(value) === region)) return false;
    return word.occurrences >= minCount && word.collection_count >= minCollections;
  });

  return {
    words: matched.slice(offset, offset + limit).map(({ contexts, ...word }) => ({
      ...word,
      example: contexts[0] ?? null,
    })),
    total: matched.length,
    offset,
    limit,
  };
}
