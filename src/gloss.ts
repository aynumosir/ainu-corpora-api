/**
 * Curated gloss layers (Phase 8) — read helpers.
 *
 * Serves sentence-level human glosses imported from ainu-corpora-annotations
 * (see migrations/0006_curated_gloss.sql for the data model and how it
 * differs from the generated morph_gloss lookup). Two read paths:
 *
 *   - glossForSentence(id): every layer covering one sentence, parts in
 *     order, with the layer's provenance/credibility inlined so a frontend
 *     can label the block without a second request.
 *   - glossCoverage(): which documents have curated coverage, per layer —
 *     cheap enough for a UI to fetch once and badge result rows locally.
 *
 * Both degrade to empty results when the tables are absent (same policy as
 * kwic.ts missingSchema), so the Worker deploys safely before the first
 * data load.
 */

export interface GlossLayerMeta {
  id: string;
  credibility: string; // 'curated' | 'generated'
  language: string;
  status: string | null;
  author: string | null;
  origin_url: string | null;
  origin_title: string | null;
  description: string | null;
  source_repository: string | null;
  source_revision: string | null;
  retrieved_at: string | null;
}

export interface GlossPart {
  part: number;
  ain: string;
  gloss: string;
  interp: string | null;
  aligned: boolean;
  /** [[ainToken, glossToken], …] when aligned, else null (render stacked). */
  pairs: [string, string][] | null;
  notes: unknown[] | null;
  divergence: unknown[] | null;
}

export interface SentenceGloss {
  sentence_id: string;
  layers: (GlossLayerMeta & { parts: GlossPart[] })[];
}

export interface GlossCoverage {
  layers: (GlossLayerMeta & {
    documents: { document: string; sentences: number }[];
    sentences: number;
  })[];
}

function missingSchema(e: unknown): boolean {
  return /no such table: (gloss_layers|curated_gloss)/i.test(String(e instanceof Error ? e.message : e));
}

/** Parse a stored JSON column, tolerating NULL and malformed content. */
function fromJson<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

interface LayerRow {
  id: string;
  credibility: string;
  language: string;
  status: string | null;
  author: string | null;
  origin_url: string | null;
  origin_title: string | null;
  description: string | null;
  source_repository: string | null;
  source_revision: string | null;
  retrieved_at: string | null;
}

const LAYER_COLS =
  "l.id, l.credibility, l.language, l.status, l.author, l.origin_url, l.origin_title, l.description, l.source_repository, l.source_revision, l.retrieved_at";

function layerMeta(r: LayerRow): GlossLayerMeta {
  return {
    id: r.id,
    credibility: r.credibility,
    language: r.language,
    status: r.status ?? null,
    author: r.author ?? null,
    origin_url: r.origin_url ?? null,
    origin_title: r.origin_title ?? null,
    description: r.description ?? null,
    source_repository: r.source_repository ?? null,
    source_revision: r.source_revision ?? null,
    retrieved_at: r.retrieved_at ?? null,
  };
}

export async function glossForSentence(db: D1Database, sentenceId: string): Promise<SentenceGloss> {
  try {
    const { results } = await db
      .prepare(
        `SELECT g.layer_id, g.part_idx, g.ain, g.gloss, g.interp, g.aligned, g.pairs, g.notes, g.divergence,
                ${LAYER_COLS}
         FROM curated_gloss g JOIN gloss_layers l ON l.id = g.layer_id
         WHERE g.sentence_id = ?
         ORDER BY g.layer_id, g.part_idx`,
      )
      .bind(sentenceId)
      .all<
        LayerRow & {
          layer_id: string;
          part_idx: number;
          ain: string;
          gloss: string;
          interp: string | null;
          aligned: number;
          pairs: string | null;
          notes: string | null;
          divergence: string | null;
        }
      >();
    const layers = new Map<string, GlossLayerMeta & { parts: GlossPart[] }>();
    for (const r of results ?? []) {
      let layer = layers.get(r.layer_id);
      if (!layer) {
        layer = { ...layerMeta(r), parts: [] };
        layers.set(r.layer_id, layer);
      }
      layer.parts.push({
        part: r.part_idx,
        ain: r.ain,
        gloss: r.gloss,
        interp: r.interp ?? null,
        aligned: !!r.aligned,
        pairs: fromJson<[string, string][]>(r.pairs),
        notes: fromJson<unknown[]>(r.notes),
        divergence: fromJson<unknown[]>(r.divergence),
      });
    }
    return { sentence_id: sentenceId, layers: [...layers.values()] };
  } catch (e) {
    if (missingSchema(e)) return { sentence_id: sentenceId, layers: [] };
    throw e;
  }
}

export async function glossCoverage(db: D1Database): Promise<GlossCoverage> {
  try {
    const { results: docs } = await db
      .prepare(
        `SELECT layer_id, substr(sentence_id, 1, instr(sentence_id, '#') - 1) AS document,
                COUNT(DISTINCT sentence_id) AS sentences
         FROM curated_gloss
         GROUP BY layer_id, document
         ORDER BY layer_id, document`,
      )
      .all<{ layer_id: string; document: string; sentences: number }>();
    const { results: metas } = await db
      .prepare(`SELECT ${LAYER_COLS} FROM gloss_layers l ORDER BY l.id`)
      .all<LayerRow>();
    const layers = (metas ?? []).map((m) => {
      const documents = (docs ?? [])
        .filter((d) => d.layer_id === m.id)
        .map((d) => ({ document: d.document, sentences: d.sentences }));
      return { ...layerMeta(m), documents, sentences: documents.reduce((n, d) => n + d.sentences, 0) };
    });
    return { layers };
  } catch (e) {
    if (missingSchema(e)) return { layers: [] };
    throw e;
  }
}
