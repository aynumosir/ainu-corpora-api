/**
 * Continuous-text reading (Phase 9) — read helpers.
 *
 * A registered source (one with a db.aynu.org slug) is read document by
 * document: a document is the sentence-id prefix before '#', and its
 * sentences occupy one contiguous `row_order` range. `text_documents`
 * (migrations/0007_text_documents.sql) holds that range per document so a
 * page of text is one indexed range scan; `TEXT_DOCUMENTS_REBUILD_SQL`
 * rebuilds the table from `sentences` and runs after every load.
 *
 * `text` is the active text of the corpus: the modern-orthography sidecar
 * where one is loaded (Batchelor Bible, Murasaki-notation Sakhalin texts),
 * the source transcription elsewhere. `source_text` carries the printed
 * spelling when a sidecar is active, so a reader can show both.
 *
 * Every helper degrades to an empty result while the table is absent (same
 * policy as gloss.ts), so the Worker deploys safely before the rebuild.
 */

export const TEXT_PAGE_LIMIT_DEFAULT = 500;
export const TEXT_PAGE_LIMIT_MAX = 1000;

export interface TextSourceSummary {
  source_slug: string;
  documents: number;
  sentences: number;
  translated: number;
  /** Sidecar id when every document of the source carries the same one. */
  text_layer: string | null;
  text_layer_status: string | null;
}

export interface TextDocument {
  key: string;
  ord: number;
  title: string | null;
  sentences: number;
  translated: number;
  text_layer: string | null;
  text_layer_status: string | null;
  uri: string | null;
}

export interface TextSentence {
  id: string;
  /** 0-based position within the document. */
  index: number;
  text: string;
  /** Printed spelling when `text` comes from a modern-orthography sidecar. */
  source_text: string | null;
  text_layer: string | null;
  text_layer_status: string | null;
  translation: string | null;
  dialect: string | null;
  author: string | null;
  uri: string | null;
}

export interface TextDocumentPage {
  document: TextDocument;
  prev: Pick<TextDocument, "key" | "title"> | null;
  next: Pick<TextDocument, "key" | "title"> | null;
  sentences: TextSentence[];
  total: number;
  offset: number;
  limit: number;
}

export const TEXT_DOCUMENTS_REBUILD_SQL = [
  "DELETE FROM text_documents",
  `INSERT INTO text_documents
     (source_slug, key, ord, title, row_start, row_end, sentences, translated, text_layer, text_layer_status, uri)
   SELECT source_slug, key,
          row_number() OVER (PARTITION BY source_slug ORDER BY row_start) - 1,
          title, row_start, row_end, n, translated, text_layer, text_layer_status, uri
   FROM (
     SELECT source_slug,
            substr(id, 1, instr(id, '#') - 1) AS key,
            min(document) AS title,
            min(row_order) AS row_start,
            max(row_order) AS row_end,
            count(*) AS n,
            sum(translation IS NOT NULL AND translation <> '') AS translated,
            CASE WHEN count(text_layer) = count(*) THEN min(text_layer) END AS text_layer,
            CASE WHEN count(text_layer) = count(*) THEN min(text_layer_status) END AS text_layer_status,
            min(uri) AS uri
     FROM sentences
     WHERE source_slug IS NOT NULL AND source_slug <> '' AND instr(id, '#') > 0
     GROUP BY source_slug, key
   )`,
];

function missingSchema(e: unknown): boolean {
  const s = String(e instanceof Error ? e.message : e);
  return /no such table: text_documents/i.test(s);
}

function clampLimit(n: number | undefined): number {
  if (n == null || !Number.isFinite(n) || n <= 0) return TEXT_PAGE_LIMIT_DEFAULT;
  return Math.min(Math.floor(n), TEXT_PAGE_LIMIT_MAX);
}

function clampOffset(n: number | undefined): number {
  if (n == null || !Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

interface DocRow {
  key: string;
  ord: number;
  title: string | null;
  row_start: number;
  row_end: number;
  sentences: number;
  translated: number;
  text_layer: string | null;
  text_layer_status: string | null;
  uri: string | null;
}

function toDocument(r: DocRow): TextDocument {
  return {
    key: r.key,
    ord: Number(r.ord),
    title: r.title ?? null,
    sentences: Number(r.sentences),
    translated: Number(r.translated),
    text_layer: r.text_layer ?? null,
    text_layer_status: r.text_layer_status ?? null,
    uri: r.uri ?? null,
  };
}

/** Every source with readable text, with its document and sentence totals. */
export async function textSources(db: D1Database): Promise<TextSourceSummary[]> {
  try {
    const { results } = await db
      .prepare(
        `SELECT source_slug,
                count(*) AS documents,
                sum(sentences) AS sentences,
                sum(translated) AS translated,
                CASE WHEN count(text_layer) = count(*) AND count(DISTINCT text_layer) = 1 THEN min(text_layer) END AS text_layer,
                CASE WHEN count(text_layer) = count(*) AND count(DISTINCT text_layer) = 1 THEN min(text_layer_status) END AS text_layer_status
         FROM text_documents
         GROUP BY source_slug
         ORDER BY source_slug`,
      )
      .all<TextSourceSummary>();
    return results.map((r) => ({
      source_slug: r.source_slug,
      documents: Number(r.documents),
      sentences: Number(r.sentences),
      translated: Number(r.translated),
      text_layer: r.text_layer ?? null,
      text_layer_status: r.text_layer_status ?? null,
    }));
  } catch (e) {
    if (missingSchema(e)) return [];
    throw e;
  }
}

/** The documents of one source in reading order. Empty when the source has no text. */
export async function textDocuments(db: D1Database, sourceSlug: string): Promise<TextDocument[]> {
  try {
    const { results } = await db
      .prepare(
        `SELECT key, ord, title, row_start, row_end, sentences, translated, text_layer, text_layer_status, uri
         FROM text_documents WHERE source_slug = ? ORDER BY ord`,
      )
      .bind(sourceSlug)
      .all<DocRow>();
    return results.map(toDocument);
  } catch (e) {
    if (missingSchema(e)) return [];
    throw e;
  }
}

interface SentenceRow {
  id: string;
  row_order: number;
  text: string;
  legacy_text: string | null;
  text_layer: string | null;
  text_layer_status: string | null;
  translation: string | null;
  dialect: string | null;
  author: string | null;
  uri: string | null;
}

/**
 * One page of a document's sentences in reading order, with the neighbouring
 * documents for navigation. `null` when the document does not exist.
 */
export async function textDocument(
  db: D1Database,
  sourceSlug: string,
  key: string,
  opts: { offset?: number; limit?: number } = {},
): Promise<TextDocumentPage | null> {
  let doc: DocRow | null;
  try {
    doc = await db
      .prepare(
        `SELECT key, ord, title, row_start, row_end, sentences, translated, text_layer, text_layer_status, uri
         FROM text_documents WHERE source_slug = ? AND key = ?`,
      )
      .bind(sourceSlug, key)
      .first<DocRow>();
  } catch (e) {
    if (missingSchema(e)) return null;
    throw e;
  }
  if (!doc) return null;

  const limit = clampLimit(opts.limit);
  const offset = Math.min(clampOffset(opts.offset), Math.max(0, Number(doc.sentences) - 1));
  const rowStart = Number(doc.row_start);
  const rowEnd = Number(doc.row_end);

  const [{ results: rows }, { results: neighbours }] = await Promise.all([
    db
      .prepare(
        `SELECT id, row_order, text, legacy_text, text_layer, text_layer_status, translation, dialect, author, uri
         FROM sentences
         WHERE source_slug = ? AND row_order BETWEEN ? AND ?
         ORDER BY row_order LIMIT ? OFFSET ?`,
      )
      .bind(sourceSlug, rowStart, rowEnd, limit, offset)
      .all<SentenceRow>(),
    db
      .prepare(
        `SELECT key, ord, title FROM text_documents
         WHERE source_slug = ? AND ord IN (?, ?) ORDER BY ord`,
      )
      .bind(sourceSlug, Number(doc.ord) - 1, Number(doc.ord) + 1)
      .all<{ key: string; ord: number; title: string | null }>(),
  ]);

  const prevRow = neighbours.find((n) => Number(n.ord) === Number(doc.ord) - 1) ?? null;
  const nextRow = neighbours.find((n) => Number(n.ord) === Number(doc.ord) + 1) ?? null;

  return {
    document: toDocument(doc),
    prev: prevRow ? { key: prevRow.key, title: prevRow.title ?? null } : null,
    next: nextRow ? { key: nextRow.key, title: nextRow.title ?? null } : null,
    sentences: rows.map((r) => ({
      id: r.id,
      index: Number(r.row_order) - rowStart,
      text: r.text,
      source_text: r.legacy_text ?? null,
      text_layer: r.text_layer ?? null,
      text_layer_status: r.text_layer_status ?? null,
      translation: r.translation && r.translation !== "" ? r.translation : null,
      dialect: r.dialect ?? null,
      author: r.author ?? null,
      uri: r.uri ?? null,
    })),
    total: Number(doc.sentences),
    offset,
    limit,
  };
}
