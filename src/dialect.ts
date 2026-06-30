/**
 * Three-level dialect filtering shared by every search surface.
 *
 * The corpus dialect taxonomy is hierarchical (see migrations/0003):
 *   lv1  region        北海道 (Hokkaido) | 樺太 (Sakhalin)
 *   lv2  region/area    北海道/南西, 樺太/西海岸, …
 *   lv3  region/area/X  北海道/南西/沙流, …  (a sentence may belong to several)
 *
 * Callers can filter three ways (most → least structured):
 *   - `region`       exact lv1 ("北海道" | "樺太") — the UI Hokkaido/Sakhalin tab.
 *   - `dialectPath`  a hierarchical path prefix ("北海道/南西" or
 *                    "北海道/南西/沙流") — matches that node and everything below
 *                    it, via an anchored substring scan over `dialect_paths`.
 *   - `dialect`      LEGACY free-text substring over the raw `dialect` column,
 *                    kept byte-identical for backward compatibility.
 *
 * All three are ANDed when more than one is supplied. The returned fragment is
 * pre-AND-joined (each clause starts with " AND ") so callers append directly.
 */

const US = "\u001f"; // unit separator wrapping each stored path (see loader)

export interface DialectFilter {
  region?: string | null;
  dialectPath?: string | null;
  dialect?: string | null;
}

/**
 * Build the dialect WHERE fragment + bound params for a sentence table aliased
 * as `alias` (e.g. "s"). Returns `{ sql, params }`; `sql` is "" when no filter
 * is requested. Each clause is prefixed with " AND ".
 */
export function dialectWhere(alias: string, f: DialectFilter): { sql: string; params: unknown[] } {
  const a = alias ? `${alias}.` : "";
  let sql = "";
  const params: unknown[] = [];
  if (f.region) {
    sql += ` AND ${a}region = ?`;
    params.push(f.region);
  }
  if (f.dialectPath) {
    // Anchored membership: every stored path is wrapped in US, so US||prefix
    // matches the prefix node and any deeper path, never a sibling region.
    sql += ` AND instr(${a}dialect_paths, ?) > 0`;
    params.push(US + f.dialectPath);
  }
  if (f.dialect) {
    sql += ` AND instr(${a}dialect, ?) > 0`;
    params.push(f.dialect);
  }
  return { sql, params };
}

/** True when any structured/legacy dialect filter is present. */
export function hasDialectFilter(f: DialectFilter): boolean {
  return !!(f.region || f.dialectPath || f.dialect);
}

/** Detect a query against the pre-Phase-5 schema (no region/dialect_paths). */
export function missingDialectColumns(e: unknown): boolean {
  return /no such column:.*(region|dialect_path)/i.test(String(e instanceof Error ? e.message : e));
}

/**
 * The dialect taxonomy actually present in the corpus, as a tree for the UI:
 *   [{ region: "北海道", count, areas: [{ path:"北海道/南西", name:"南西", count,
 *      dialects:[{ path:"北海道/南西/沙流", name:"沙流", count }] }] }]
 * Built from the per-sentence `dialect_path` (the most-specific path). A path
 * with <3 segments contributes to its region/area only. Sentences with no
 * dialect are omitted. Counts are sentence counts at-or-below each node.
 */
export interface DialectArea { path: string; name: string; count: number; dialects: { path: string; name: string; count: number }[] }
export interface DialectRegion { region: string; count: number; areas: DialectArea[] }

export async function dialectTree(db: D1Database): Promise<DialectRegion[]> {
  const { results } = await db
    .prepare(
      `SELECT dialect_path AS path, count(*) AS count
       FROM sentences WHERE dialect_path IS NOT NULL AND dialect_path <> ''
       GROUP BY dialect_path`,
    )
    .all<{ path: string; count: number }>();
  const regions = new Map<string, DialectRegion>();
  // Accumulate counts up the hierarchy from each leaf path.
  for (const r of results ?? []) {
    const segs = String(r.path).split("/");
    const regionName = segs[0];
    if (!regionName) continue;
    let region = regions.get(regionName);
    if (!region) regions.set(regionName, (region = { region: regionName, count: 0, areas: [] }));
    region.count += r.count;
    if (segs.length < 2) continue;
    const areaPath = segs.slice(0, 2).join("/");
    let area = region.areas.find((a) => a.path === areaPath);
    if (!area) region.areas.push((area = { path: areaPath, name: segs[1], count: 0, dialects: [] }));
    area.count += r.count;
    if (segs.length < 3) continue;
    const dialectPath = segs.slice(0, 3).join("/");
    let d = area.dialects.find((x) => x.path === dialectPath);
    if (!d) area.dialects.push((d = { path: dialectPath, name: segs[2], count: 0 }));
    d.count += r.count;
  }
  // Sort: regions and children by descending count.
  const out = [...regions.values()].sort((a, b) => b.count - a.count);
  for (const region of out) {
    region.areas.sort((a, b) => b.count - a.count);
    for (const area of region.areas) area.dialects.sort((a, b) => b.count - a.count);
  }
  return out;
}
