// src/db.ts
import Database from "@tauri-apps/plugin-sql";

/* =========================
   Tipos
   ========================= */
export type FolderRow = {
  id: number;
  parent_id: number | null;
  name: string;
  guid: string | null;
  updated_at: string | null;
  deleted: number;
};
export type BlockRow = {
  id: number;
  folder_id: number;
  position: number;
  text: string;
  link_url: string | null;      // ✅ enlace asociado al bloque (nullable)
  guid: string | null;
  updated_at: string | null;
  deleted: number;
};

/* =========================
   Utils
   ========================= */
// ✅ nombre de BD distinto para NO colisionar con la suite original
const DB_URL = "sqlite:chain_list_editor.sqlite";
let db: Database | null = null;

const nowIso = () => new Date().toISOString();
const hexGuid = () => crypto.randomUUID().replace(/-/g, "").toLowerCase();

const removeAccents = (s: string) =>
  s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

function resolveCollisionName(existing: string[], name: string): string {
  const trimmed = name.trim();
  if (!existing.includes(trimmed)) return trimmed;
  let base = trimmed;
  let ext = "";
  const dot = trimmed.lastIndexOf(".");
  if (dot > 0) {
    base = trimmed.slice(0, dot);
    ext = trimmed.slice(dot);
  }
  let i = 1;
  // evita nombres repetidos con sufijo (n)
  while (true) {
    const cand = `${base}(${i})${ext}`;
    if (!existing.includes(cand)) return cand;
    i++;
  }
}

/* =========================
   Conexión + esquema (+ migraciones)
   ========================= */
export async function getDb(): Promise<Database> {
  if (db) return db;
  db = await Database.load(DB_URL);

  // PRAGMAs
  await db.execute("PRAGMA foreign_keys=ON;");
  await db.execute("PRAGMA journal_mode=WAL;");
  await db.execute("PRAGMA synchronous=NORMAL;");
  await db.execute("PRAGMA temp_store=MEMORY;");

  // Tablas
  await db.execute(`
    CREATE TABLE IF NOT EXISTS meta(
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS folders(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      guid TEXT,
      updated_at TEXT,
      deleted INTEGER DEFAULT 0
    );
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS blocks(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      -- ⚠️ 'link_url' puede no existir si la BD es previa: se añade en la migración de abajo
      guid TEXT,
      updated_at TEXT,
      deleted INTEGER DEFAULT 0
    );
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS settings(
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Índices
  await db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_guid ON folders(guid);");
  await db.execute("CREATE INDEX IF NOT EXISTS idx_folders_parent_del_name ON folders(COALESCE(parent_id,0),deleted,name COLLATE NOCASE);");
  await db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_guid ON blocks(guid);");
  await db.execute("CREATE INDEX IF NOT EXISTS idx_blocks_folder_del ON blocks(folder_id,deleted);");
  await db.execute("CREATE INDEX IF NOT EXISTS idx_blocks_folder_del_pos ON blocks(folder_id,deleted,position);");

  // ── Migración: añadir columna 'link_url' si falta (y migrar desde 'link' si existía) ──
  const cols = await db.select<{ name: string }[]>("PRAGMA table_info(blocks);");
  const hasLinkUrl = cols.some(c => c.name === "link_url");
  const hasLegacyLink = cols.some(c => c.name === "link");

  if (!hasLinkUrl) {
    await db.execute("ALTER TABLE blocks ADD COLUMN link_url TEXT;");
  }
  // Copia datos legacy si existían y la nueva columna está vacía
  if (hasLegacyLink) {
    await db.execute("UPDATE blocks SET link_url = COALESCE(link_url, link) WHERE link IS NOT NULL AND TRIM(link) <> '';");
  }

  // Root
  const root = await db.select<{ id: number }[]>(
    "SELECT id FROM folders WHERE parent_id IS NULL LIMIT 1"
  );
  if (root.length === 0) {
    await db.execute(
      "INSERT INTO folders(parent_id,name,guid,updated_at,deleted) VALUES (NULL,?,?,?,0)",
      ["categorias", hexGuid(), nowIso()]
    );
  }

  // Rellena guid/updated_at si faltan (idempotente)
  const ts = nowIso();
  await db.execute("UPDATE folders SET guid=lower(hex(randomblob(16))) WHERE IFNULL(guid,'')='';");
  await db.execute("UPDATE folders SET updated_at=? WHERE IFNULL(updated_at,'')='';", [ts]);
  await db.execute("UPDATE blocks SET guid=lower(hex(randomblob(16))) WHERE IFNULL(guid,'')='';");
  await db.execute("UPDATE blocks SET updated_at=? WHERE IFNULL(updated_at,'')='';", [ts]);

  return db;
}

/* =========================
   Settings (JSON)
   ========================= */
export async function getSetting<T = unknown>(key: string, def: T | null = null): Promise<T | null> {
  const d = await getDb();
  const r = await d.select<{ value: string }[]>("SELECT value FROM settings WHERE key=?", [key]);
  if (!r.length) return def;
  try {
    return JSON.parse(r[0].value) as T;
  } catch {
    return (r[0].value as unknown as T) ?? def;
  }
}
export async function setSetting(key: string, val: unknown): Promise<void> {
  const d = await getDb();
  await d.execute(
    "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [key, JSON.stringify(val)]
  );
}

/* =========================
   Helpers GUID
   ========================= */
export async function folderIdByGuid(guid?: string | null): Promise<number | null> {
  if (!guid) return null;
  const d = await getDb();
  const r = await d.select<{ id: number }[]>(
    "SELECT id FROM folders WHERE guid=? AND deleted=0 LIMIT 1",
    [guid]
  );
  return r.length ? r[0].id : null;
}
export async function blockByGuid(guid?: string | null): Promise<BlockRow | undefined> {
  if (!guid) return undefined;
  const d = await getDb();
  const r = await d.select<BlockRow[]>(
    "SELECT id, folder_id, position, text, link_url, guid, updated_at, deleted FROM blocks WHERE guid=? AND deleted=0 LIMIT 1",
    [guid]
  );
  return r[0];
}

/* =========================
   Carpetas (CRUD)
   ========================= */
export async function getRoot(): Promise<FolderRow> {
  const d = await getDb();
  const r = await d.select<FolderRow[]>(
    "SELECT * FROM folders WHERE parent_id IS NULL LIMIT 1"
  );
  return r[0];
}

export async function listChildren(parentId: number | null): Promise<FolderRow[]> {
  const d = await getDb();
  if (parentId == null) {
    return d.select<FolderRow[]>(
      "SELECT * FROM folders WHERE parent_id IS NULL AND deleted=0 ORDER BY name COLLATE NOCASE"
    );
  }
  return d.select<FolderRow[]>(
    "SELECT * FROM folders WHERE parent_id=? AND deleted=0 ORDER BY name COLLATE NOCASE",
    [parentId]
  );
}

export async function createFolder(parentId: number | null, name: string): Promise<FolderRow> {
  const d = await getDb();
  const siblings = await d.select<{ name: string }[]>(
    "SELECT name FROM folders WHERE COALESCE(parent_id,0)=COALESCE(?,0) AND deleted=0",
    [parentId]
  );
  const unique = resolveCollisionName(siblings.map(s => s.name), name);
  const guid = hexGuid();
  await d.execute(
    "INSERT INTO folders(parent_id,name,guid,updated_at,deleted) VALUES(?,?,?,?,0)",
    [parentId, unique, guid, nowIso()]
  );
  const r = await d.select<FolderRow[]>("SELECT * FROM folders WHERE guid=? LIMIT 1", [guid]);
  return r[0];
}

export async function renameFolder(id: number, newName: string): Promise<void> {
  const d = await getDb();
  const cur = await d.select<{ parent_id: number | null; name: string }[]>(
    "SELECT parent_id,name FROM folders WHERE id=?",
    [id]
  );
  if (!cur.length) return;
  const parentId = cur[0].parent_id;
  const oldName = cur[0].name;
  const siblings = await d.select<{ name: string }[]>(
    "SELECT name FROM folders WHERE COALESCE(parent_id,0)=COALESCE(?,0) AND deleted=0",
    [parentId]
  );
  const pool = siblings.map(s => s.name).filter(n => n !== oldName);
  const unique = resolveCollisionName(pool, newName);
  await d.execute("UPDATE folders SET name=?, updated_at=? WHERE id=?", [unique, nowIso(), id]);
}

export async function deleteFolder(id: number): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE folders SET deleted=1, updated_at=? WHERE id=?", [nowIso(), id]);
}

export async function moveFolder(id: number, newParentId: number | null): Promise<void> {
  const d = await getDb();
  const cur = await d.select<{ name: string }[]>("SELECT name FROM folders WHERE id=?", [id]);
  if (!cur.length) return;
  const name = cur[0].name;
  const siblings = await d.select<{ name: string }[]>(
    "SELECT name FROM folders WHERE COALESCE(parent_id,0)=COALESCE(?,0) AND deleted=0",
    [newParentId]
  );
  const unique = resolveCollisionName(siblings.map(s => s.name), name);
  await d.execute(
    "UPDATE folders SET parent_id=?, name=?, updated_at=? WHERE id=?",
    [newParentId, unique, nowIso(), id]
  );
}

/* ===== Carpetas por GUID (para eventos WS) ===== */
export async function createFolderByGuids(
  parent_guid: string | null,
  folder_guid: string,
  name: string,
  ts?: string
): Promise<void> {
  const d = await getDb();

  // Idempotente por GUID
  const exists = await d.select<{ id: number }[]>(
    "SELECT id FROM folders WHERE guid=? LIMIT 1",
    [folder_guid]
  );
  if (exists.length) return;

  // ⚠️ Fallback: si no conozco el parent_guid → usar ID del root (NO NULL)
  let parentId = await folderIdByGuid(parent_guid || undefined);
  if (parentId == null) {
    const root = await getRoot();
    parentId = root.id;
  }

  const siblings = await d.select<{ name: string }[]>(
    "SELECT name FROM folders WHERE COALESCE(parent_id,0)=COALESCE(?,0) AND deleted=0",
    [parentId]
  );
  const unique = resolveCollisionName(siblings.map(s => s.name), name);
  await d.execute(
    "INSERT INTO folders(parent_id,name,guid,updated_at,deleted) VALUES(?,?,?,?,0)",
    [parentId, unique, folder_guid.toLowerCase(), ts ?? nowIso()]
  );
}

export async function renameFolderByGuid(folder_guid: string, newName: string): Promise<void> {
  const d = await getDb();
  const row = await d.select<{ id: number; parent_id: number | null; name: string }[]>(
    "SELECT id,parent_id,name FROM folders WHERE guid=? AND deleted=0",
    [folder_guid]
  );
  if (!row.length) return;
  const fid = row[0].id;
  const parentId = row[0].parent_id;
  const curName = row[0].name;
  const siblings = await d.select<{ name: string }[]>(
    "SELECT name FROM folders WHERE COALESCE(parent_id,0)=COALESCE(?,0) AND deleted=0",
    [parentId]
  );
  const pool = siblings.map(s => s.name).filter(n => n !== curName);
  const unique = resolveCollisionName(pool, newName.trim());
  await d.execute("UPDATE folders SET name=?, updated_at=? WHERE id=?", [unique, nowIso(), fid]);
}

export async function deleteFolderByGuid(folder_guid: string): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE folders SET deleted=1, updated_at=? WHERE guid=?", [nowIso(), folder_guid]);
}

export async function moveFolderByGuids(folder_guid: string, new_parent_guid: string | null): Promise<void> {
  const d = await getDb();
  const row = await d.select<{ id: number; name: string }[]>(
    "SELECT id,name FROM folders WHERE guid=? AND deleted=0",
    [folder_guid]
  );
  if (!row.length) return;
  const fid = row[0].id;
  const name = row[0].name;

  // ⚠️ Fallback: si no conozco el new_parent_guid → usar ID del root (NO NULL)
  let newPid = await folderIdByGuid(new_parent_guid || undefined);
  if (newPid == null) {
    const root = await getRoot();
    newPid = root.id;
  }

  const siblings = await d.select<{ name: string }[]>(
    "SELECT name FROM folders WHERE COALESCE(parent_id,0)=COALESCE(?,0) AND deleted=0",
    [newPid]
  );
  const unique = resolveCollisionName(siblings.map(s => s.name), name);
  await d.execute(
    "UPDATE folders SET parent_id=?, name=?, updated_at=? WHERE id=?",
    [newPid, unique, nowIso(), fid]
  );
}

/* =========================
   Bloques
   ========================= */
export async function blocksCount(folderId: number): Promise<number> {
  const d = await getDb();
  const r = await d.select<{ c: number }[]>(
    "SELECT COUNT(*) AS c FROM blocks WHERE folder_id=? AND deleted=0",
    [folderId]
  );
  return r[0].c;
}

/**
 * Devuelve los bloques de una página (filtrados si hay búsqueda)
 * y el TOTAL GLOBAL sin filtro (para paginación consistente).
 */
export async function listBlocks(
  folderId: number,
  searchText: string,
  limit: number,
  offset: number
): Promise<{ rows: BlockRow[]; total: number }> {
  const d = await getDb();
  const total = await blocksCount(folderId); // total global

  const all = await d.select<BlockRow[]>(
    "SELECT id, folder_id, position, text, link_url, guid, updated_at, deleted FROM blocks WHERE folder_id=? AND deleted=0 ORDER BY position ASC",
    [folderId]
  );

  let rows = all;
  const q = searchText?.trim();
  if (q) {
    const needle = removeAccents(q);
    // Por compatibilidad, si alguna BD vieja conserva 'link', también se intenta (sin romper si no existe)
    let legacyMatches: Set<number> | null = null;
    try {
      const legacy = await d.select<{ id: number; link: string | null }[]>(
        "SELECT id, link FROM blocks WHERE folder_id=? AND deleted=0",
        [folderId]
      );
      legacyMatches = new Set(
        legacy
          .filter(r => removeAccents(r.link ?? "").includes(needle))
          .map(r => r.id)
      );
    } catch {
      // no-op si no existe columna legacy
    }

    rows = all.filter(r =>
      removeAccents(r.text || "").includes(needle) ||
      removeAccents(r.link_url ?? "").includes(needle) ||
      (legacyMatches ? legacyMatches.has(r.id) : false)
    );
  }

  const page = rows.slice(offset, offset + limit);
  return { rows: page, total };
}

export async function ensureAtLeastOneBlock(
  folderId: number
): Promise<{ id: number; guid: string; position: number; text: string; link_url: string | null } | null> {
  const d = await getDb();
  const r = await d.select<{ id: number }[]>(
    "SELECT id FROM blocks WHERE folder_id=? AND deleted=0 LIMIT 1",
    [folderId]
  );
  if (r.length) return null;

  const guid = hexGuid();
  const ts = nowIso();
  const maxp = await d.select<{ m: number }[]>(
    "SELECT COALESCE(MAX(position),0) AS m FROM blocks WHERE folder_id=? AND deleted=0",
    [folderId]
  );
  const pos = (maxp[0]?.m ?? 0) + 1;

  await d.execute(
    "INSERT INTO blocks(folder_id,position,text,link_url,guid,updated_at,deleted) VALUES(?,?,?,?,?,?,0)",
    [folderId, pos, "", null, guid, ts]
  );
  return { id: (await blockIdByGuid(guid))!, guid, position: pos, text: "", link_url: null };
}

async function blockIdByGuid(guid: string): Promise<number | null> {
  const d = await getDb();
  const r = await d.select<{ id: number }[]>(
    "SELECT id FROM blocks WHERE guid=? AND deleted=0 LIMIT 1",
    [guid]
  );
  return r.length ? r[0].id : null;
}

/**
 * Crea bloque. Si `position` es null, va al final.
 * Si `forcedGuid` existe ya, devuelve ese bloque (idempotente) y NO inserta.
 * `link_url` es opcional (para cuando el servidor crea/mueve con link inicial).
 *
 * 🔧 Cambios: si existe el GUID con deleted=1, “resucita” la fila en la nueva carpeta
 * y/o posición para evitar UNIQUE 2067.
 */
export async function createBlock(
  folderId: number,
  text: string,
  position: number | null,
  forcedGuid?: string,
  link_url?: string | null
): Promise<{ id: number; guid: string; position: number; text: string; link_url: string | null }> {
  const d = await getDb();
  const guid = (forcedGuid ? forcedGuid.toLowerCase() : hexGuid());
  const ts = nowIso();

  // 🔎 busca por GUID sin filtrar deleted
  const existing = await d.select<(BlockRow & { deleted: number })[]>(
    "SELECT id, folder_id, position, text, link_url, guid, updated_at, deleted FROM blocks WHERE guid=? LIMIT 1",
    [guid]
  );

  if (existing.length) {
    const e = existing[0];

    // ✅ ya activo → idempotente
    if (e.deleted === 0) {
      return {
        id: e.id,
        guid: e.guid!,
        position: e.position,
        text: e.text ?? "",
        link_url: e.link_url ?? null,
      };
    }

    // ♻️ estaba borrado → resucitar
    let pos = position ?? null;
    if (pos == null) {
      const r = await d.select<{ m: number }[]>(
        "SELECT COALESCE(MAX(position),0) AS m FROM blocks WHERE folder_id=? AND deleted=0",
        [folderId]
      );
      pos = (r[0]?.m ?? 0) + 1;
    } else {
      await d.execute(
        "UPDATE blocks SET position=position+1 WHERE folder_id=? AND position>=? AND deleted=0",
        [folderId, pos]
      );
    }

    await d.execute(
      `UPDATE blocks
         SET folder_id=?,
             position=?,
             text=?,
             link_url=?,
             updated_at=?,
             deleted=0
       WHERE id=?`,
      [folderId, pos, text ?? "", link_url ?? null, ts, e.id]
    );

    const row = await d.select<BlockRow[]>(
      "SELECT id, folder_id, position, text, link_url, guid, updated_at, deleted FROM blocks WHERE id=?",
      [e.id]
    );
    const revived = row[0];
    return {
      id: revived.id,
      guid: revived.guid!,
      position: revived.position,
      text: revived.text ?? "",
      link_url: revived.link_url ?? null,
    };
  }

  // ➕ inserción normal (no existía)
  let pos = position ?? null;
  if (pos == null) {
    const r = await d.select<{ m: number }[]>(
      "SELECT COALESCE(MAX(position),0) AS m FROM blocks WHERE folder_id=? AND deleted=0",
      [folderId]
    );
    pos = (r[0]?.m ?? 0) + 1;
  } else {
    await d.execute(
      "UPDATE blocks SET position=position+1 WHERE folder_id=? AND position>=? AND deleted=0",
      [folderId, pos]
    );
  }

  await d.execute(
    "INSERT INTO blocks(folder_id,position,text,link_url,guid,updated_at,deleted) VALUES(?,?,?,?,?,?,0)",
    [folderId, pos, text ?? "", link_url ?? null, guid, ts]
  );
  const row = await d.select<BlockRow[]>(
    "SELECT id, folder_id, position, text, link_url, guid, updated_at, deleted FROM blocks WHERE guid=? LIMIT 1",
    [guid]
  );
  const created = row[0];
  return {
    id: created.id,
    guid: created.guid!,
    position: created.position,
    text: created.text ?? "",
    link_url: created.link_url ?? null
  };
}
export const dbCreateBlock = createBlock;

export async function editBlock(id: number, text: string): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE blocks SET text=?, updated_at=? WHERE id=?", [text ?? "", nowIso(), id]);
}
export const dbEditBlock = editBlock;

// ✅ establecer/limpiar link_url por ID
export async function setBlockLink(id: number, link_url: string | null): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE blocks SET link_url=?, updated_at=? WHERE id=?", [link_url ?? null, nowIso(), id]);
}
export const dbSetBlockLink = setBlockLink;

// ✅ útil para eventos por GUID (WS)
export async function setBlockLinkByGuid(block_guid: string, link_url: string | null): Promise<void> {
  const d = await getDb();
  await d.execute(
    "UPDATE blocks SET link_url=?, updated_at=? WHERE guid=? AND deleted=0",
    [link_url ?? null, nowIso(), block_guid]
  );
}

export async function deleteBlock(id: number): Promise<void> {
  const d = await getDb();
  const r = await d.select<{ folder_id: number; position: number }[]>(
    "SELECT folder_id,position FROM blocks WHERE id=?",
    [id]
  );
  if (!r.length) return;
  const folderId = r[0].folder_id;
  const pos = r[0].position;

  await d.execute("UPDATE blocks SET deleted=1, updated_at=? WHERE id=?", [nowIso(), id]);
  await d.execute(
    "UPDATE blocks SET position=position-1 WHERE folder_id=? AND position>? AND deleted=0",
    [folderId, pos]
  );
}
export const dbDeleteBlock = deleteBlock;

export async function moveBlock(id: number, newPosition: number): Promise<void> {
  const d = await getDb();
  const r = await d.select<{ folder_id: number; position: number }[]>(
    "SELECT folder_id, position FROM blocks WHERE id=?",
    [id]
  );
  if (!r.length) return;
  const folderId = r[0].folder_id;
  const oldPos = r[0].position;
  if (newPosition === oldPos) return;

  const total = await blocksCount(folderId);
  const dest = Math.max(1, Math.min(total, newPosition));

  if (dest < oldPos) {
    await d.execute(
      "UPDATE blocks SET position=position+1 WHERE folder_id=? AND position>=? AND position<? AND deleted=0",
      [folderId, dest, oldPos]
    );
  } else {
    await d.execute(
      "UPDATE blocks SET position=position-1 WHERE folder_id=? AND position>? AND position<=? AND deleted=0",
      [folderId, oldPos, dest]
    );
  }
  await d.execute("UPDATE blocks SET position=?, updated_at=? WHERE id=?", [dest, nowIso(), id]);
}
export const dbMoveBlock = moveBlock;
