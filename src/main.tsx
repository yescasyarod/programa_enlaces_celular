import React, {
  useState,
  useLayoutEffect,
  useRef,
  useEffect,
  useCallback,
  useImperativeHandle,
  forwardRef,
  ChangeEvent,
  useMemo,
} from "react";
import ReactDOM from "react-dom/client";
import { confirm } from "@tauri-apps/plugin-dialog";
import WebSocket, { Message } from "@tauri-apps/plugin-websocket";
import { openUrl /*, openPath, revealItemInDir */ } from "@tauri-apps/plugin-opener";

import {
  getDb,
  getRoot,
  listChildren,
  createFolder,
  renameFolder as dbRenameFolder,
  deleteFolder as dbDeleteFolder,
  listBlocks,
  ensureAtLeastOneBlock,
  editBlock as dbEditBlock,
  deleteBlock as dbDeleteBlock,
  moveBlock as dbMoveBlock,
  folderIdByGuid,
  blockByGuid,
  createFolderByGuids,
  renameFolderByGuid,
  deleteFolderByGuid,
  moveFolderByGuids,
  type FolderRow,
  type BlockRow,
} from "./db";

import "./styles.css";

// Helper con fallback a web
async function openExternalLink(raw: string) {
  const url = (raw || "").trim();
  if (!url) return;
  // normaliza si viene sin protocolo
  const finalUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    await openUrl(finalUrl);
  } catch {
    window.open(finalUrl, "_blank", "noopener,noreferrer");
  }
}

/* =========================================================================
   🔒 Centinelas: AUTORIDAD = SERVIDOR
   ========================================================================= */
// (Eliminadas utilidades no usadas que daban TS6133)

/* =========================================
   Helpers mover entre carpetas (DB local)
   ========================================= */
   async function getNextPositionInFolderByGuid(folderGuid: string): Promise<number> {
    const fid = await folderIdByGuid(folderGuid);
    if (fid == null) return 1;
    const d = await getDb();
    // última posición NO vacía → insertamos antes del centinela
    const rows = await d.select<{ pos: number }[]>(
      "SELECT position AS pos FROM blocks WHERE folder_id=? AND deleted=0 AND TRIM(IFNULL(text,''))<>'' ORDER BY position DESC LIMIT 1",
      [fid]
    );
    return rows.length ? rows[0].pos + 1 : 1;
  }


  async function dbMoveBlockToFolderEndByGuids(blockGuid: string, destFolderGuid: string) {
    const b = await blockByGuid(blockGuid);
    if (!b) return;
    const d = await getDb();
  
    const destFolderId = await folderIdByGuid(destFolderGuid);
    if (destFolderId == null) return;
  
    // Inserción: después del último NO vacío (antes del centinela)
    const lastNon = await d.select<{ pos: number }[]>(
      "SELECT position AS pos FROM blocks WHERE folder_id=? AND deleted=0 AND TRIM(IFNULL(text,''))<>'' ORDER BY position DESC LIMIT 1",
      [destFolderId]
    );
    const insertPos = lastNon.length ? lastNon[0].pos + 1 : 1;
  
    await d.execute("BEGIN"); // PATCH
    try {
      // Abrir hueco en destino
      await d.execute(
        "UPDATE blocks SET position=position+1 WHERE folder_id=? AND deleted=0 AND position>=?",
        [destFolderId, insertPos]
      );
  
      // Compactar origen si cambia de carpeta
      const srcFolderIdRow = await d.select<{ fid: number; pos: number }[]>(
        "SELECT folder_id AS fid, position AS pos FROM blocks WHERE id=?",
        [b.id]
      );
      const srcFid = srcFolderIdRow[0]?.fid;
      const srcPos = srcFolderIdRow[0]?.pos;
      if (srcFid != null && srcFid !== destFolderId && srcPos != null) {
        await d.execute(
          "UPDATE blocks SET position=position-1 WHERE folder_id=? AND position>? AND deleted=0",
          [srcFid, srcPos]
        );
      }
  
      // Mover el bloque
      await d.execute("UPDATE blocks SET folder_id=?, position=? WHERE id=?", [
        destFolderId,
        insertPos,
        b.id,
      ]);
  
      await d.execute("COMMIT");
    } catch (e) {
      await d.execute("ROLLBACK");
      throw e;
    }
  }
  

/* =========================
   WS + Sync bus
   ========================= */
let ws: WebSocket | null = null;
const WS_URL = "ws://192.168.1.103:9011";
const DEVICE_ID_KEY = "device_id_linked";
const LAST_EVENT_ID_KEY = "last_event_id_linked";
const LAST_FOLDER_GUID_KEY = "last_folder_guid_linked";

/* =========================
   WS Health / Reconnect (JS)
   ========================= */
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
const MAX_BACKOFF_MS = 60_000;
const PING_INTERVAL_MS = 15_000; // ping de aplicación (mantiene NAT y detecta zombi)
let pingTimer: ReturnType<typeof setInterval> | null = null;

function scheduleReconnect(initial = false) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const base = initial ? 500 : Math.min(2 ** reconnectAttempts * 1000, MAX_BACKOFF_MS);
  const jitter = base * (0.8 + Math.random() * 0.4);
  reconnectAttempts = Math.min(reconnectAttempts + 1, 10);
  reconnectTimer = setTimeout(() => {
    void ensureWs(); // intenta reconectar
  }, jitter);
}

function startAppPing(socket: WebSocket) {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    // “ping” de aplicación. El servidor lo ignorará, sirve para mantener vivo el NAT
    // y detectar conexiones zombis (si falla el send, forzamos reconexión).
    socket
      .send(JSON.stringify({ type: "client_ping", ts: new Date().toISOString() }))
      .catch(() => {
        // si falla, dejamos que el close listener dispare la reconexión
        stopAppPing();
        ws = null;
        scheduleReconnect();
      });
  }, PING_INTERVAL_MS);
}

function stopAppPing() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}


/** ❗️Protección anti “morder letras” */
const PROTECT_LOCAL_MS = 900;
/** Última edición local por id de bloque (SQL id) */
const lastLocalEditAt: Record<number, number> = {};
const markLocalEdit = (blockSqlId: number) => {
  lastLocalEditAt[blockSqlId] = Date.now();
};

type SyncListener = () => void;
const syncListeners = new Set<SyncListener>();
type SyncUnsubscribe = () => void;

function onSync(cb: SyncListener): SyncUnsubscribe {
  syncListeners.add(cb);
  return () => {
    syncListeners.delete(cb);
  };
}
function emitSync() {
  for (const cb of Array.from(syncListeners)) {
    try {
      cb();
    } catch {}
  }
}

const getDeviceId = () => {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
};
const getLastEventId = () => Number(localStorage.getItem(LAST_EVENT_ID_KEY) || "0");
const setLastEventId = (n: number) => localStorage.setItem(LAST_EVENT_ID_KEY, String(n));

function messageToString(msg: Message): string {
  if (msg.type === "Text") return msg.data as string;
  if (msg.type === "Binary") {
    try {
      return new TextDecoder().decode(new Uint8Array(msg.data as number[]));
    } catch {
      return "[binary]";
    }
  }
  return String((msg as any)?.data ?? "");
}

async function sendHello(socket: WebSocket) {
  const device_id = getDeviceId();
  const since_event_id = getLastEventId();
  await socket.send(JSON.stringify({ type: "hello", device_id, since_event_id }));
}

async function ensureWs(): Promise<WebSocket | null> {
  if (ws) return ws;
  try {
    ws = await WebSocket.connect(WS_URL);

    // conexión OK: resetea backoff y arranca ping de app
    reconnectAttempts = 0;
    stopAppPing();
    startAppPing(ws);

    (ws as any).addListenerError?.((e: unknown) => {
      console.error("[WS] error:", e);
      // deja que el close haga el scheduleReconnect
    });
    (ws as any).addListenerClose?.((code: number, reason: string) => {
      console.warn("[WS] closed:", code, reason);
      stopAppPing();
      ws = null;
      scheduleReconnect(); // ← reconecta solo
    });

    ws.addListener(async (m: Message) => {
      const text = messageToString(m);
      let msg: any;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg?.type !== "event") return;

      // ⤵️ tu lógica existente de aplicación de eventos
      const eid = Number(msg.event_id || 0);
      if (eid > 0) setLastEventId(eid);

      const inner = msg.inner_type as string;
      const p = msg.payload || {};
      const ts = msg.ts as string | undefined;

      try {
        if (inner === "edit_block") {
          const b = await blockByGuid(p.block_guid);
          if (b) {
            const last = lastLocalEditAt[b.id] ?? 0;
            if (Date.now() - last >= PROTECT_LOCAL_MS) {
              await dbEditBlock(b.id, p.text ?? "");
            }
          } else {
            // ⤵️ CONVERTIR EL CENTINELA EN EL BLOQUE REAL (en lugar de crear uno nuevo)
            const fid = p.folder_guid
              ? await folderIdByGuid(p.folder_guid)
              : await folderIdByGuid((await getRoot()).guid);

            if (fid != null) {
              const d = await getDb();
              // último bloque de la carpeta
              const tail = await d.select<{ id: number; text: string | null }[]>(
                "SELECT id, text FROM blocks WHERE folder_id=? AND deleted=0 ORDER BY position DESC LIMIT 1",
                [fid]
              );
              const lastIsEmpty = tail.length > 0 && (tail[0].text ?? "").trim() === "";
              const nowIso = new Date().toISOString();
              const linkArg = (((p.url ?? p.link) ?? "") as string).trim() || null;

              if (lastIsEmpty) {
                // convierte centinela -> bloque real con el GUID remoto
                await d.execute(
                  "UPDATE blocks SET text=?, guid=?, link_url=?, updated_at=? WHERE id=?",
                  [p.text ?? "", p.block_guid, linkArg, nowIso, tail[0].id]
                );
              } else {
                // (raro) no hay centinela: insertar ANTES del centinela lógico
                // = después del último NO vacío (transaccionado)
                const lastNon = await d.select<{ pos: number }[]>(
                  "SELECT position AS pos FROM blocks WHERE folder_id=? AND deleted=0 AND TRIM(IFNULL(text,''))<>'' ORDER BY position DESC LIMIT 1",
                  [fid]
                );
                const insertPos = lastNon.length ? lastNon[0].pos + 1 : 1;

                await d.execute("BEGIN");
                try {
                  // Double-check idempotencia por si otra ruta ya materializó el GUID
                  const dupe = await blockByGuid(p.block_guid);
                  if (!dupe) {
                    await d.execute(
                      "UPDATE blocks SET position=position+1 WHERE folder_id=? AND deleted=0 AND position>=?",
                      [fid, insertPos]
                    );
                    await d.execute(
                      "INSERT INTO blocks(folder_id, position, text, guid, link_url, updated_at, deleted) VALUES(?,?,?,?,?,?,0)",
                      [fid, insertPos, p.text ?? "", p.block_guid, linkArg, nowIso]
                    );
                  }
                  await d.execute("COMMIT");
                } catch (e) {
                  await d.execute("ROLLBACK");
                  throw e;
                }
              } // fin if (lastIsEmpty)
            } // fin if (fid != null)
          } // fin else (!b)
          emitSync();
          return;
        } else if (inner === "create_block") {
          const already = await blockByGuid(p.block_guid);
          if (already) {
            // solo actualizar texto/enlace si llegó algo
            const d = await getDb();
            const nowIso = new Date().toISOString();
            await d.execute(
              "UPDATE blocks SET text=?, link_url=?, updated_at=? WHERE id=?",
              [p.text ?? "", (((p.url ?? p.link) ?? "") as string).trim() || null, nowIso, already.id]
            );
            emitSync();
            return;
          }

          const fid = p.folder_guid
            ? await folderIdByGuid(p.folder_guid)
            : await folderIdByGuid((await getRoot()).guid);

          if (fid != null) {
            const isSentinel = !((p.text ?? "").trim());
            const d = await getDb();
            const nowIso = new Date().toISOString();
            const linkArg = (((p.url ?? p.link) ?? "") as string).trim() || null;

            if (isSentinel) {
              const tail = await d.select<{ id: number; text: string }[]>(
                "SELECT id, text FROM blocks WHERE folder_id=? AND deleted=0 ORDER BY position DESC LIMIT 1",
                [fid]
              );
              const alreadyEmptyAtEnd = tail.length > 0 && (tail[0].text ?? "").trim() === "";
              if (!alreadyEmptyAtEnd) {
                await d.execute(
                  "INSERT INTO blocks(folder_id, position, text, guid, link_url, updated_at, deleted) " +
                    "SELECT ?, COALESCE(MAX(position),0)+1, '', ?, NULL, ?, 0 FROM blocks WHERE folder_id=?",
                  [fid, p.block_guid, nowIso, fid]
                );
              }
            } else {
              // insertar ANTES del centinela = después del último NO vacío (transaccionado)
              const lastNon = await d.select<{ pos: number }[]>(
                "SELECT position AS pos FROM blocks WHERE folder_id=? AND deleted=0 AND TRIM(IFNULL(text,''))<>'' ORDER BY position DESC LIMIT 1",
                [fid]
              );
              const insertPos = lastNon.length ? lastNon[0].pos + 1 : 1;

              await d.execute("BEGIN");
              try {
                // Double-check idempotencia por GUID antes de insertar
                const dupe = await blockByGuid(p.block_guid);
                if (!dupe) {
                  await d.execute(
                    "UPDATE blocks SET position=position+1 WHERE folder_id=? AND deleted=0 AND position>=?",
                    [fid, insertPos]
                  );
                  await d.execute(
                    "INSERT INTO blocks(folder_id, position, text, guid, link_url, updated_at, deleted) VALUES(?,?,?,?,?,?,0)",
                    [fid, insertPos, p.text ?? "", p.block_guid, linkArg, nowIso]
                  );
                }
                await d.execute("COMMIT");
              } catch (e) {
                await d.execute("ROLLBACK");
                throw e;
              }
            } // fin else (no sentinela)
          } // fin if (fid != null)

          emitSync();
          return;
        } else if (inner === "delete_block") {
          const b = await blockByGuid(p.block_guid);
          if (b) await dbDeleteBlock(b.id);
        } else if (inner === "move_block") {
          const b = await blockByGuid(p.block_guid);
          if (b && p.new_position != null) await dbMoveBlock(b.id, Number(p.new_position));
          if (p.new_folder_guid) {
            const blockGuid: string = p.block_guid;
            const newFolderGuid: string = p.new_folder_guid;
            if (blockGuid && newFolderGuid) {
              await dbMoveBlockToFolderEndByGuids(blockGuid, newFolderGuid);
            }
          }
        } else if (inner === "move_block_to_folder" || (inner === "move_block" && p.new_folder_guid)) {
          const blockGuid: string = p.block_guid;
          const newFolderGuid: string = p.new_folder_guid;
          if (blockGuid && newFolderGuid) {
            await dbMoveBlockToFolderEndByGuids(blockGuid, newFolderGuid);
          }
        } else if (inner === "create_folder") {
          const already = await folderIdByGuid(p.folder_guid);
          if (already == null) {
            await createFolderByGuids(p.parent_guid ?? null, p.folder_guid, p.name, ts);
          }
        } else if (inner === "rename_folder") {
          await renameFolderByGuid(p.folder_guid, p.name);
        } else if (inner === "delete_folder") {
          await deleteFolderByGuid(p.folder_guid);
        } else if (inner === "move_folder") {
          await moveFolderByGuids(p.folder_guid, p.new_parent_guid);
        } else if (inner === "set_block_link") {
          const b = await blockByGuid(p.block_guid);
          if (b) {
            const d = await getDb();
            const val = ((p.url ?? p.link) ?? "").trim();
            await d.execute("UPDATE blocks SET link_url=?, updated_at=? WHERE id=?", [
              val || null,
              new Date().toISOString(),
              b.id,
            ]);
          }
        }
      } catch (e) {
        console.error("[WS] apply error:", e, inner, p);
      }

      emitSync();
    });

    await sendHello(ws);
  } catch (e) {
    console.error("WS connect failed:", e);
    ws = null;
    scheduleReconnect(true); // primer intento rápido
  }
  return ws;
}



async function wsEmit(obj: any): Promise<void> {
  try {
    const socket = await ensureWs();
    if (!socket) {
      console.warn("WS not connected; dropped:", obj?.type ?? obj);
      return;
    }
    await socket.send(JSON.stringify(obj));
  } catch (e) {
    console.error("WS send failed:", e, "payload:", obj?.type ?? obj);
    ws = null;
  }
}

/* =========================
   Tipos locales
   ========================= */
interface BlockColumnProps {
  currentFolderId: number;
  currentFolderGuid: string;
  fontSize: number;
  searchText: string;
  moveTo: number; // 1-based
  onFocusChange: (focusedIndex: number) => void; // 0-based
}
export interface BlockColumnHandle {
  moveBlock: (dir: number) => void;
  prevPage: () => void;
  nextPage: () => void;
  moveToPage: (page: number) => void;
  totalPages: () => number;
  moveBlockRelativeTo: (anchor: number, side: "above" | "below") => void;

  getSelectedBlocks: () => Array<{ guid: string; text: string }>;
  clearSelection: () => void;
}

/* ============================================================
   Helpers ABSOLUTOS (reordenamiento independiente de la página)
   ============================================================ */
async function getAbsoluteCount(folderId: number): Promise<number> {
  const d = await getDb();
  const rows = await d.select<{ c: number }[]>(
    "SELECT COUNT(*) AS c FROM blocks WHERE folder_id=? AND deleted=0",
    [folderId]
  );
  return rows[0]?.c ?? 0;
}
async function getByAbsolutePosition(folderId: number, absPos1Based: number) {
  const d = await getDb();
  const rows = await d.select<BlockRow[]>(
    `SELECT id, folder_id, position, text, guid, updated_at, deleted
     FROM blocks
     WHERE folder_id=? AND deleted=0
     ORDER BY position ASC
     LIMIT 1 OFFSET ?`,
    [folderId, Math.max(0, absPos1Based - 1)]
  );
  return rows[0] ?? null;
}

/* Pequeño helper para encontrar una carpeta por id recorriendo el árbol */
async function findFolderRowById(id: number): Promise<FolderRow | null> {
  const queue: FolderRow[] = [await getRoot()];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur.id === id) return cur;
    const kids = await listChildren(cur.id);
    queue.push(...kids);
  }
  return null;
}

/* =========================
   BlockColumn (SQLite + WS)
   ========================= */
const BlockColumn = forwardRef<BlockColumnHandle, BlockColumnProps>(function BlockColumn(
  { currentFolderId, currentFolderGuid, fontSize = 14, searchText, moveTo, onFocusChange },
  ref
) {
  const BLOCKS_PER_PAGE = 20;

  const [rows, setRows] = useState<BlockRow[]>([]);
  const [total, setTotal] = useState(0);
  const [absTotal, setAbsTotal] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);

  const [selected, setSelected] = useState<Set<string>>(new Set());

  const wsTimersRef = useRef<Record<number, ReturnType<typeof setTimeout> | undefined>>({});
  const composingRef = useRef<Record<number, boolean>>({});

  // 🔒 Shadow local por bloque (para evitar parpadeos tras escribir)
  const shadowRef = useRef<Record<number, { text: string; until: number }>>({});
  const focusedIdRef = useRef<number | null>(null);
  const idleExtendTimersRef = useRef<Record<number, ReturnType<typeof setTimeout> | undefined>>({});

  // refs de UI
  const areaRefs = useRef<Record<number, HTMLTextAreaElement | null>>({});
  const listRef = useRef<HTMLDivElement | null>(null);
  // diálogo de enlace
  const [linkDialog, setLinkDialog] = useState<{ open: boolean; row: BlockRow | null; url: string }>({
    open: false, row: null, url: ""
  });

  // timers de long-press por fila
  const longPressTimersRef = useRef<Record<number, ReturnType<typeof setTimeout> | undefined>>({});
  const LONG_PRESS_MS = 500;

  const startLongPress = (row: BlockRow) => {
    clearLongPress(row.id);
    longPressTimersRef.current[row.id] = setTimeout(() => {
      setLinkDialog({ open: true, row, url: ((row as any).link_url ?? "") as string });
    }, LONG_PRESS_MS);
  };

  const clearLongPress = (id: number) => {
    const t = longPressTimersRef.current[id];
    if (t) clearTimeout(t);
    longPressTimersRef.current[id] = undefined;
  };

  // -- Ajuste de altura estable (anclando el scroll para evitar saltos al ESCRIBIR)
  const adjustHeightStable = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    const list = listRef.current;

    const prevBehavior = list?.style.scrollBehavior;
    if (list) list.style.scrollBehavior = "auto";

    const beforeTop = el.offsetTop; // ancla vertical previa
    el.style.height = "auto";
    const next = el.scrollHeight;
    el.style.height = `${next}px`;
    const afterTop = el.offsetTop;

    if (list) {
      // Compensar cualquier cambio en el offsetTop del textarea
      list.scrollTop += (afterTop - beforeTop);
    }

    if (list) list.style.scrollBehavior = prevBehavior ?? "";
  };

  const recalcAllHeights = () => {
    rows.forEach((r) => adjustHeightStable(areaRefs.current[r.id]));
  };

  // ⭐️ Ajustar SOLO la altura disponible de la lista cuando cambia el viewport (sin MutationObserver ni scrollTo global)
  useEffect(() => {
    const listEl = listRef.current;
    if (!listEl) return;

    const vv = (window as any).visualViewport as VisualViewport | undefined;

    const computeMax = () => {
      const rect = listEl.getBoundingClientRect();
      const vh = vv ? vv.height : window.innerHeight;

      // margen inferior de seguridad
      const bottomSafe = 16;

      // Alto disponible desde el top del contenedor hasta el “fondo visual”
      const avail = Math.max(80, Math.floor(vh - rect.top - bottomSafe));

      // aplica sin animación
      listEl.style.maxHeight = `${avail}px`;
    };

    computeMax();

    vv?.addEventListener("resize", computeMax);
    vv?.addEventListener("scroll", computeMax);

    const onWinResize = () => computeMax();
    window.addEventListener("resize", onWinResize);

    return () => {
      vv?.removeEventListener("resize", computeMax);
      vv?.removeEventListener("scroll", computeMax);
      window.removeEventListener("resize", onWinResize);
    };
  }, [currentPage, rows.length]);

  // Duraciones shadow
  const SHADOW_MS = 1200;
  const SHADOW_IME_MS = 4500;
  const SHADOW_AFTER_BLUR_MS = 400;

  const setShadow = (id: number, text: string, extraMs: number) => {
    const now = Date.now();
    shadowRef.current[id] = { text, until: now + extraMs };
  };

  const extendWhileIdle = (id: number, baseMs: number) => {
    const t = idleExtendTimersRef.current[id];
    if (t) clearTimeout(t);
    idleExtendTimersRef.current[id] = setTimeout(() => {}, baseMs - 50);
  };

  // ⬇️ Si hay shadow vigente, úsalo
  const mergeWithShadow = (incoming: BlockRow[]): BlockRow[] => {
    const now = Date.now();
    return incoming.map((r) => {
      const s = shadowRef.current[r.id];
      if (s && s.until > now) return { ...r, text: s.text };
      return r;
    });
  };

  const refreshPage = useCallback(
    async (page: number) => {
      const offset = (page - 1) * BLOCKS_PER_PAGE;
      const { rows, total } = await listBlocks(currentFolderId, searchText, BLOCKS_PER_PAGE, offset);
      setRows(mergeWithShadow(rows));
      setTotal(total);
      setAbsTotal(await getAbsoluteCount(currentFolderId));
    },
    [currentFolderId, searchText]
  );

  useLayoutEffect(() => {
    recalcAllHeights();
  }, [rows, currentPage, fontSize]);

  const syncDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const off = onSync(() => {
      if (syncDebounceRef.current) clearTimeout(syncDebounceRef.current);
      syncDebounceRef.current = setTimeout(() => {
        refreshPage(currentPage);
      }, 110);
    });
    return off;
  }, [currentPage, refreshPage]);

  useEffect(() => {
    (async () => {
      const created = await ensureAtLeastOneBlock(currentFolderId);
      setCurrentPage(1);
      await refreshPage(1);

      if (created) {
        await wsEmit({
          type: "create_block",
          device_id: getDeviceId(),
          ts: new Date().toISOString(),
          payload: {
            folder_guid: currentFolderGuid,
            block_guid: created.guid,
            position: created.position,
            text: created.text || "",
          },
        });
      }
    })();
  }, [currentFolderId, refreshPage, currentFolderGuid]);

  useEffect(() => {
    refreshPage(currentPage);
  }, [searchText, currentPage, refreshPage]);

  const totalPages = Math.max(1, Math.ceil(total / BLOCKS_PER_PAGE));

  const debounceWsEdit = (block: BlockRow, text: string) => {
    const t = wsTimersRef.current[block.id];
    if (t) clearTimeout(t);
    wsTimersRef.current[block.id] = setTimeout(async () => {
      await wsEmit({
        type: "edit_block",
        device_id: getDeviceId(),
        ts: new Date().toISOString(),
        payload: { block_guid: block.guid, folder_guid: currentFolderGuid, text },
      });
      wsTimersRef.current[block.id] = undefined;
    }, 180);
  };

  const flushWsNow = async (block: BlockRow) => {
    const latest = rows.find((r) => r.id === block.id)?.text ?? block.text ?? "";
    await wsEmit({
      type: "edit_block",
      device_id: getDeviceId(),
      ts: new Date().toISOString(),
      payload: { block_guid: block.guid, folder_guid: currentFolderGuid, text: latest },
    });
    const t = wsTimersRef.current[block.id];
    if (t) {
      clearTimeout(t);
      wsTimersRef.current[block.id] = undefined;
    }
  };

  // Fuerza flush inmediato por id SQL del bloque anterior cuando cambiamos el foco
  const flushBlockByIdNow = useCallback(
    async (sqlId: number) => {
      const blk = rows.find((r) => r.id === sqlId);
      if (blk) {
        await flushWsNow(blk);
      }
    },
    [rows]
  );

  // Flush en cierre/ocultación
  useEffect(() => {
    const handler = () => {
      const timers = wsTimersRef.current;
      Object.keys(timers).forEach((k) => {
        const id = Number(k);
        if (timers[id]) {
          const blk = rows.find((r) => r.id === id);
          if (blk) flushWsNow(blk);
        }
      });
    };
    document.addEventListener("visibilitychange", handler);
    window.addEventListener("pagehide", handler);
    window.addEventListener("beforeunload", handler);
    return () => {
      document.removeEventListener("visibilitychange", handler);
      window.removeEventListener("pagehide", handler);
      window.removeEventListener("beforeunload", handler);
    };
  }, [rows, currentFolderGuid]);

  const persistNow = async (row: BlockRow, val: string) => {
    markLocalEdit(row.id);
    await dbEditBlock(row.id, val);
    debounceWsEdit(row, val);
  };

  const onChange = async (row: BlockRow, val: string, _idxInPage: number) => {
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, text: val } : r)));
    adjustHeightStable(areaRefs.current[row.id]!);

    markLocalEdit(row.id);

    const isComposing = !!composingRef.current[row.id];
    const extra = isComposing ? SHADOW_IME_MS : SHADOW_MS;

    setShadow(row.id, val, extra);
    extendWhileIdle(row.id, extra);

    if (isComposing) return;

    const wasEmpty = !(row.text ?? "").trim();
    const nowHasText = (val ?? "").trim().length > 0;
    // sólo cuenta si NO hay búsqueda y contra el total ABSOLUTO
    const isLastGlobally = searchText.trim() === "" && row.position === absTotal;

    if (isLastGlobally && wasEmpty && nowHasText) {
      // primera tecla en el último bloque vacío:
      // guarda local y emite EDIT; el servidor creará el centinela.
      await dbEditBlock(row.id, val);
      await wsEmit({
        type: "edit_block",
        device_id: getDeviceId(),
        ts: new Date().toISOString(),
        payload: { block_guid: row.guid, folder_guid: currentFolderGuid, text: val },
      });
      return;
    }

    await persistNow(row, val);
  };

  const onDelete = async (row: BlockRow) => {
    if (total === 1) {
      markLocalEdit(row.id);
      await dbEditBlock(row.id, "");
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, text: "" } : r)));
      await wsEmit({
        type: "edit_block",
        device_id: getDeviceId(),
        ts: new Date().toISOString(),
        payload: { block_guid: row.guid, folder_guid: currentFolderGuid, text: "" },
      });
      return;
    }
    await dbDeleteBlock(row.id);
    await wsEmit({
      type: "delete_block",
      device_id: getDeviceId(),
      ts: new Date().toISOString(),
      payload: { block_guid: row.guid },
    });

    setSelected((prev) => {
      const copy = new Set(prev);
      if (row.guid) copy.delete(row.guid); // ✅ evita pasar null
      return copy;
    });

    const newTotal = total - 1;
    setTotal(newTotal);
    const maxPage = Math.max(1, Math.ceil(newTotal / BLOCKS_PER_PAGE));
    const newPage = Math.min(currentPage, maxPage);
    setCurrentPage(newPage);
    await refreshPage(newPage);
  };

  useEffect(() => {
    if (moveTo < 1 || moveTo > total) return;
    const newPage = Math.floor((moveTo - 1) / BLOCKS_PER_PAGE) + 1;
    setCurrentPage(newPage);
  }, [moveTo, total]);

  useImperativeHandle(ref, () => ({
    // Mover arriba/abajo desde la posición actual (moveTo), por ABSOLUTO
    async moveBlock(dir: number) {
      const absTotal = await getAbsoluteCount(currentFolderId);
      if (absTotal < 1) return;

      const fromPos = Math.max(1, Math.min(absTotal, moveTo || 1));
      const toPos = Math.max(1, Math.min(absTotal, fromPos + dir));
      if (toPos === fromPos) return;

      const moved = await getByAbsolutePosition(currentFolderId, fromPos);
      if (!moved) return;

      await dbMoveBlock(moved.id, toPos);
      await wsEmit({
        type: "move_block",
        device_id: getDeviceId(),
        ts: new Date().toISOString(),
        payload: { block_guid: moved.guid, new_position: toPos },
      });

      onFocusChange(toPos - 1);
      const newPage = Math.floor((toPos - 1) / BLOCKS_PER_PAGE) + 1;
      setCurrentPage(newPage);
      await refreshPage(newPage);
    },

    // Mover relativo al #anchor (arriba/abajo), por ABSOLUTO
    async moveBlockRelativeTo(anchor: number, side: "above" | "below") {
      const absTotal = await getAbsoluteCount(currentFolderId);
      if (absTotal < 1) return;

      const fromPos = Math.max(1, Math.min(absTotal, moveTo || 1));
      let toPos = side === "above" ? anchor - 1 : anchor;
      toPos = Math.max(1, Math.min(absTotal, toPos));
      if (toPos === fromPos) return;

      const moved = await getByAbsolutePosition(currentFolderId, fromPos);
      if (!moved) return;

      await dbMoveBlock(moved.id, toPos);
      await wsEmit({
        type: "move_block",
        device_id: getDeviceId(),
        ts: new Date().toISOString(),
        payload: { block_guid: moved.guid, new_position: toPos },
      });

      onFocusChange(toPos - 1);
      const newPage = Math.floor((toPos - 1) / BLOCKS_PER_PAGE) + 1;
      setCurrentPage(newPage);
      await refreshPage(newPage);
    },

    prevPage: () => setCurrentPage((p) => Math.max(1, p - 1)),
    nextPage: () => setCurrentPage((p) => Math.min(totalPages, p + 1)),
    moveToPage: (page: number) => setCurrentPage(Math.min(Math.max(1, page), totalPages)),
    totalPages: () => totalPages,

    getSelectedBlocks: () => {
      const textsByGuid = new Map<string, string>();
      rows.forEach((r) => {
        if (r.guid) textsByGuid.set(r.guid, r.text ?? ""); // ✅ evita set con null
      });
      return Array.from(selected).map((g) => ({ guid: g, text: textsByGuid.get(g) ?? "" }));
    },
    clearSelection: () => setSelected(new Set()),
  }));

  // Acepta guid opcional para no romper el set cuando sea null
  const toggleSelected = (guid: string | null, on: boolean) => {
    if (!guid) return; // ✅ ignora filas sin guid
    setSelected((prev) => {
      const copy = new Set(prev);
      if (on) copy.add(guid);
      else copy.delete(guid);
      return copy;
    });
  };
  // Guarda link local + WS y refresca fila sin parpadeo
const saveLinkForRow = async (row: BlockRow, urlRaw: string) => {
  const url = (urlRaw || "").trim();
  const d = await getDb();
  await d.execute(
    "UPDATE blocks SET link_url=?, updated_at=? WHERE id=?",
    [ url || null, new Date().toISOString(), row.id ]
  );
  setRows(prev => prev.map(r => r.id === row.id ? { ...r, ...( { link_url: url || null } as any) } : r));

  await wsEmit({
    type: "set_block_link",
    device_id: getDeviceId(),
    ts: new Date().toISOString(),
    payload: { block_guid: row.guid, link: url }
  });
};

// Abre el enlace (si existe)
const openRowLink = async (row: BlockRow) => {
  const url = ((row as any).link_url ?? "").trim();
  if (!url) return;
  await openExternalLink(url);
};


  return (
    <>
      <div className="blocks-list" ref={listRef}>
        {rows.map((row, i) => {
          const globalIndex = (currentPage - 1) * BLOCKS_PER_PAGE + i;
          const isChecked = !!row.guid && selected.has(row.guid); // ✅
          return (
            <div className="block-item" key={row.id}>
              {/* rail izq: número + checkbox */}
              <div
                className="block-left-rail"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 6,
                  marginRight: 8,
                }}
              >
                <span className="block-number">#{globalIndex + 1}</span>
                <input
                  type="checkbox"
                  aria-label="Seleccionar bloque"
                  checked={isChecked}
                  onChange={(e) => { if (row.guid) toggleSelected(row.guid, e.currentTarget.checked); }}
                  style={{ cursor: "pointer" }}
                  disabled={!row.guid}
                  title={!row.guid ? "Bloque sin GUID (no seleccionable)" : "Seleccionar bloque"}
                />
              </div>

              {/* contenido */}
              <div style={{ flex: 1 }}>
                <textarea
                  ref={(el) => {
                    areaRefs.current[row.id] = el;
                    adjustHeightStable(el);
                  }}
                  onInput={(e) => adjustHeightStable(e.currentTarget)}
                  value={row.text}
                  onChange={(e) => onChange(row, e.currentTarget.value, i)}
                  onFocus={() => {
                    const prev = focusedIdRef.current;
                    if (prev && prev !== row.id) {
                      void flushBlockByIdNow(prev);
                    }
                    focusedIdRef.current = row.id;
                  }}
                  onBlur={() => {
                    const cur = rows.find((r) => r.id === row.id)?.text ?? "";
                    setShadow(row.id, cur, SHADOW_AFTER_BLUR_MS);
                    focusedIdRef.current = null;
                    flushWsNow(row);
                  }}
                  onCompositionStart={() => {
                    composingRef.current[row.id] = true;
                    const cur = rows.find((r) => r.id === row.id)?.text ?? "";
                    setShadow(row.id, cur, SHADOW_IME_MS);
                  }}
                  onCompositionEnd={(e) => {
                    composingRef.current[row.id] = false;
                    const v = e.currentTarget.value;   // ✅ cachea
                    onChange(row, v, i);
                  }}
                  placeholder="Escribe aquí…"
                  style={{
                    fontSize: `${fontSize ?? 14}px`,
                    lineHeight: 1.4,
                    width: "100%",
                    resize: "none",
                    overflow: "hidden",
                  }}
                  className="block-textarea"
                />
              </div>

              {/* rail der: copiar + borrar */}
              <div
                className="block-right-rail"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 6,
                  marginLeft: 8,
                }}
              >
                {/* Botón ENLACE (⛓️) */}
                <button
                  className={"block-link" + (((row as any).link_url ?? "").trim() ? " has-link" : "")}
                  title={((row as any).link_url ?? "").trim() ? `Abrir: ${(row as any).link_url}` : "Asignar enlace"}
                  aria-label="Enlace del bloque"
                  // CLICK corto: abre si hay enlace; si no, abre diálogo
                  onClick={() => {
                    clearLongPress(row.id);
                    const url = ((row as any).link_url ?? "").trim();
                    if (url) openRowLink(row);
                    else setLinkDialog({ open: true, row, url: "" });
                  }}
                  // LONG PRESS (ratón)
                  onMouseDown={() => startLongPress(row)}
                  onMouseUp={() => clearLongPress(row.id)}
                  onMouseLeave={() => clearLongPress(row.id)}
                  // LONG PRESS (táctil)
                  onTouchStart={() => startLongPress(row)}
                  onTouchEnd={() => clearLongPress(row.id)}
                  onTouchCancel={() => clearLongPress(row.id)}
                >
                  🔗
                </button>

                <button
                  className="block-delete"
                  onClick={() => onDelete(row)}
                  title="Borrar bloque"
                  disabled={total === 1}
                  aria-label="Borrar bloque"
                >
                  🗑️
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {linkDialog.open && linkDialog.row && (
        <div className="overlay-modal" role="dialog" aria-modal="true">
          <div className="overlay-modal-card" style={{ width: 420, maxWidth: "95vw" }}>
            <h3 className="overlay-modal-title">Enlace del bloque</h3>

            <input
              className="overlay-modal-input"
              placeholder="https://…"
              value={linkDialog.url}
              autoFocus
              onChange={(e) => {
                const v = e.currentTarget.value;  // ✅ cachea antes
                setLinkDialog(prev => ({ ...prev, url: v }));
              }}
              onKeyDown={async (e) => {
                if (e.key === "Enter" && linkDialog.row) {
                  const url = linkDialog.url;     // ✅ no dependas de e.currentTarget tras await
                  await saveLinkForRow(linkDialog.row, url);
                  setLinkDialog({ open: false, row: null, url: "" });
                }
                if (e.key === "Escape") {
                  setLinkDialog({ open: false, row: null, url: "" });
                }
              }}
            />

            <div className="overlay-modal-actions">
              <button
                className="overlay-btn-primary"
                onClick={async () => {
                  if (linkDialog.row) {
                    await saveLinkForRow(linkDialog.row, linkDialog.url);
                    setLinkDialog({ open: false, row: null, url: "" });
                  }
                }}
              >
                Guardar
              </button>

              <button
                className="overlay-btn-secondary"
                onClick={() => setLinkDialog({ open: false, row: null, url: "" })}
              >
                Cancelar
              </button>

              {(((linkDialog.row as any)?.link_url ?? "").trim()) && (
                <button
                  className="overlay-btn-danger"
                  onClick={async () => {
                    if (linkDialog.row) {
                      await saveLinkForRow(linkDialog.row, "");
                      setLinkDialog({ open: false, row: null, url: "" });
                    }
                  }}
                  title="Quitar enlace"
                >
                  Quitar enlace
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      <div className="blocks-pagination">
        <button onClick={() => setCurrentPage(1)} disabled={currentPage === 1}>
          «
        </button>
        <button onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={currentPage === 1}>
          ‹
        </button>
        <input
          className="page-input"
          type="number"
          value={currentPage}
          min={1}
          max={totalPages}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setCurrentPage(Number(e.currentTarget.value))}
          style={{ flex: 1, minWidth: "3em" }}
        />
        <button onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}>
          ›
        </button>
        <button onClick={() => setCurrentPage(totalPages)} disabled={currentPage === totalPages}>
          »
        </button>
      </div>
    </>
  );
});

/* =========================
   MoveDialog
   ========================= */
function MoveDialog({
  open,
  initialFolder,
  onClose,
  onAccept,
}: {
  open: boolean;
  initialFolder: { id: number; name: string; guid: string } | null;
  onClose: () => void;
  onAccept: (target: { id: number; name: string; guid: string }) => void;
}) {
  const treeRef = useRef<FolderTreePanelHandle>(null);
  const [target, setTarget] = useState<{ id: number; name: string; guid: string } | null>(initialFolder);

  useEffect(() => {
    setTarget(initialFolder);
  }, [initialFolder]);

  if (!open) return null;

  return (
    <div className="overlay-modal" role="dialog" aria-modal="true">
      <div className="overlay-modal-card" style={{ width: 520, maxWidth: "95vw" }}>
        <button
          className="overlay-close"
          onClick={onClose}
          aria-label="Cerrar mover"
          style={{ position: "absolute", top: 8, right: 8 }}
        >
          ×
        </button>

        <h3 className="overlay-modal-title">Mover bloques seleccionados</h3>
        <p style={{ marginTop: -8, color: "#666" }}>
          Elige la carpeta destino (se ubicarán al <strong>final</strong>).
        </p>

        <div
          style={{
            border: "1px solid #ddd",
            borderRadius: 8,
            padding: 8,
            marginTop: 8,
            maxHeight: "50vh",
            overflow: "auto",
          }}
        >
          {target ? (
            <FolderTreePanel
              ref={treeRef}
              selected={target}
              onSelect={(f) => setTarget(f)}
              onOpen={(f) => setTarget(f)}
              showControls={false}
              skipInitialSelect
            />
          ) : null}
        </div>

        <div className="overlay-modal-actions" style={{ marginTop: 12 }}>
          <button className="overlay-btn-primary" onClick={() => target && onAccept(target)} disabled={!target}>
            Aceptar
          </button>
          <button className="overlay-btn-secondary" onClick={onClose}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}

/* =========================
   MoveFolderDialog
   ========================= */
function MoveFolderDialog({
  open,
  source,
  onClose,
  onAccept,
}: {
  open: boolean;
  source: { id: number; name: string; guid: string } | null;
  onClose: () => void;
  onAccept: (target: { id: number; name: string; guid: string }) => void;
}) {
  const treeRef = useRef<FolderTreePanelHandle>(null);
  const [target, setTarget] = useState<{ id: number; name: string; guid: string } | null>(null);

  useEffect(() => {
    setTarget(source || null);
  }, [source]);

  if (!open || !source) return null;

  return (
    <div className="overlay-modal" role="dialog" aria-modal="true">
      <div className="overlay-modal-card" style={{ width: 520, maxWidth: "95vw" }}>
        <button
          className="overlay-close"
          onClick={onClose}
          aria-label="Cerrar mover carpeta"
          style={{ position: "absolute", top: 8, right: 8 }}
        >
          ×
        </button>

        <h3 className="overlay-modal-title">Mover carpeta</h3>
        <p style={{ marginTop: -8, color: "#666" }}>
          Elige la carpeta destino para <strong>“{source.name}”</strong>.
        </p>

        <div
          style={{
            border: "1px solid #ddd",
            borderRadius: 8,
            padding: 8,
            marginTop: 8,
            maxHeight: "50vh",
            overflow: "auto",
          }}
        >
          {target ? (
            <FolderTreePanel
              ref={treeRef}
              selected={target}
              onSelect={(f) => setTarget(f)}
              onOpen={(f) => setTarget(f)}
              showControls={false}
              skipInitialSelect
            />
          ) : null}
        </div>

        <div className="overlay-modal-actions" style={{ marginTop: 12 }}>
          <button className="overlay-btn-primary" onClick={() => target && onAccept(target)} disabled={!target}>
            Aceptar
          </button>
          <button className="overlay-btn-secondary" onClick={onClose}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}

/* =========================
   FolderTreePanel
   ========================= */
type TreeNode = { id: number; name: string; children: TreeNode[]; expanded: boolean };

export interface FolderTreePanelHandle {
  createFolder: (name?: string | null) => Promise<void>;
  renameFolder: (newName?: string | null) => Promise<void>;
  deleteFolder: (opts?: { force?: boolean }) => Promise<void>;
  refresh: () => Promise<void>;
  getSelectedId: () => number | null;
}

interface FolderTreePanelProps {
  selected: { id: number | null; name: string; guid: string };
  onSelect: (folder: { id: number; name: string; guid: string }) => void;
  onOpen: (folder: { id: number; name: string; guid: string }) => void;
  showControls?: boolean;
  skipInitialSelect?: boolean;
}

const FolderTreePanel = forwardRef<FolderTreePanelHandle, FolderTreePanelProps>(function FolderTreePanel(
  { selected, onSelect, onOpen, showControls = true, skipInitialSelect = false },
  ref
) {
  const [root, setRoot] = useState<FolderRow | null>(null);
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [filter, setFilter] = useState<string>("");

  const [showMoveFolder, setShowMoveFolder] = useState(false);

  const buildTreeRec = useCallback(async (parent: FolderRow): Promise<TreeNode> => {
    const kids = await listChildren(parent.id);
    const children = await Promise.all(kids.map(buildTreeRec));
    return { id: parent.id, name: parent.name, children, expanded: true };
  }, []);

  const refresh = useCallback(async () => {
    const r = await getRoot();
    setRoot(r);
    const t = await buildTreeRec(r);
    setTree(t);
  }, [buildTreeRec]);

  useEffect(() => {
    (async () => {
      await refresh();
      if (!skipInitialSelect) {
        const r = await getRoot();
        onSelect({ id: r.id, name: r.name, guid: r.guid! });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const off = onSync(() => {
      refresh();
    });
    return off;
  }, [refresh]);

  useImperativeHandle(
    ref,
    () => ({
      createFolder: async (nameArg) => {
        const name = nameArg ?? window.prompt("Nombre de la nueva carpeta:", "");
        if (!name) return;
        const pid = selected.id ?? (await getRoot()).id;
        const row = await createFolder(pid, name.trim());

        const parentGuid =
          selected.id === null
            ? (await getRoot()).guid
            : (await getFolderRow(selected.id!))?.guid ?? (await getRoot()).guid;

        await wsEmit({
          type: "create_folder",
          device_id: getDeviceId(),
          ts: new Date().toISOString(),
          payload: { parent_guid: parentGuid, folder_guid: row.guid, name: row.name },
        });

        await refresh();
        onSelect({ id: row.id, name: row.name, guid: row.guid! });
      },

      renameFolder: async (newNameArg) => {
        if (selected.id == null || root == null || selected.id === root.id) return;
        const newName = (newNameArg ?? window.prompt("Nuevo nombre:", selected.name))?.trim();
        if (!newName) return;

        await dbRenameFolder(selected.id, newName);

        const f = await getFolderRow(selected.id);
        await wsEmit({
          type: "rename_folder",
          device_id: getDeviceId(),
          ts: new Date().toISOString(),
          payload: { folder_guid: f?.guid, name: newName },
        });

        await refresh();
        const f2 = await getFolderRow(selected.id);
        if (f2) onSelect({ id: f2.id, name: f2.name, guid: f2.guid! });
      },

      deleteFolder: async (opts) => {
        if (selected.id == null || root == null || selected.id === root.id) return;

        const force = !!opts?.force;
        if (!force) {
          const ok = await confirm(`¿Borrar “${selected.name}” y todo su contenido?`);
          if (!ok) return;
        }

        const f = await getFolderRow(selected.id!);
        await dbDeleteFolder(selected.id);

        await wsEmit({
          type: "delete_folder",
          device_id: getDeviceId(),
          ts: new Date().toISOString(),
          payload: { folder_guid: f?.guid },
        });

        await refresh();
        onSelect({ id: root.id, name: root.name, guid: root.guid! });
      },

      refresh,
      getSelectedId: () => selected.id,
    }),
    [selected, root, refresh, onSelect]
  );

  const getFolderRow = async (id: number): Promise<FolderRow | undefined> => {
    if (root && id === root.id) return root;
    const pick = (n: TreeNode | null): number[] => {
      if (!n) return [];
      return [n.id, ...n.children.flatMap(pick)];
    };
    const ids = new Set(pick(tree));
    if (!ids.has(id)) {
      await refresh();
    }
    const flatFind = async (): Promise<FolderRow | undefined> => {
      const queue: FolderRow[] = [await getRoot()];
      while (queue.length) {
        const cur = queue.shift()!;
        if (cur.id === id) return cur;
        const kids = await listChildren(cur.id);
        queue.push(...kids);
      }
      return undefined;
    };
    return flatFind();
  };

  const isDescendant = async (candidateId: number, ancestorId: number): Promise<boolean> => {
    if (candidateId === ancestorId) return true;
    const kids = await listChildren(ancestorId);
    for (const k of kids) {
      if (k.id === candidateId) return true;
      if (await isDescendant(candidateId, k.id)) return true;
    }
    return false;
  };

  const toggleNode = (id: number, node: TreeNode): TreeNode =>
    node.id === id
      ? { ...node, expanded: !node.expanded }
      : { ...node, children: node.children.map((c) => toggleNode(id, c)) };

  const renderNode = (node: TreeNode) => {
    const isSel = node.id === selected.id;
    return (
      <div key={node.id} className="folder-node">
        <div className="folder-node-header">
          {node.children.length ? (
            <span
              className="folder-node-toggle"
              onClick={(e) => {
                e.stopPropagation();
                setTree((t) => (t ? toggleNode(node.id, t) : t));
              }}
            >
              {node.expanded ? "▼" : "▶"}
            </span>
          ) : (
            <span className="folder-node-indent" />
          )}
          <span
            className={"folder-node-label" + (isSel ? " selected" : "")}
            onClick={async () => {
              const fr = await getFolderRow(node.id);
              if (fr) onSelect({ id: fr.id, name: fr.name, guid: fr.guid! });
            }}
            onDoubleClick={async () => {
              const fr = await getFolderRow(node.id);
              if (fr) onOpen({ id: fr.id, name: fr.name, guid: fr.guid! });
            }}
          >
            {node.name}
          </span>
        </div>
        {node.expanded && <div className="folder-node-children">{node.children.map(renderNode)}</div>}
      </div>
    );
  };

  // ✅ Si el padre coincide con el filtro, mostrar también TODOS sus hijos
  const filteredTree = useMemo(() => {
    if (!tree) return null;
    const q = filter.trim().toLowerCase();
    if (!q) return tree;

    const deepExpand = (n: TreeNode): TreeNode => ({
      ...n,
      expanded: true,
      children: n.children.map(deepExpand),
    });

    const filterNode = (n: TreeNode): TreeNode | null => {
      const match = n.name.toLowerCase().includes(q);
      if (match) {
        return deepExpand(n); // padre coincide -> se muestra todo su subárbol
      }
      const kids = n.children.map(filterNode).filter((c): c is TreeNode => !!c);
      return kids.length ? { ...n, children: kids, expanded: true } : null;
    };

    return filterNode(tree);
  }, [tree, filter]);

  const doMoveFolder = async (target: { id: number; name: string; guid: string }) => {
    if (selected.id == null || root == null) return;
    if (selected.id === root.id) {
      alert("No puedes mover la carpeta raíz.");
      return;
    }
    if (target.id === selected.id) {
      alert("No puedes mover una carpeta dentro de sí misma.");
      return;
    }
    if (await isDescendant(target.id, selected.id)) {
      alert("No puedes mover la carpeta a uno de sus descendientes.");
      return;
    }

    const src = await getFolderRow(selected.id);
    if (!src?.guid) return;

    await moveFolderByGuids(src.guid, target.guid);

    await wsEmit({
      type: "move_folder",
      device_id: getDeviceId(),
      ts: new Date().toISOString(),
      payload: { folder_guid: src.guid, new_parent_guid: target.guid },
    });

    await refresh();
    onSelect({ id: selected.id, name: (await getFolderRow(selected.id))?.name ?? selected.name, guid: src.guid });
  };

  return (
    <div className="folder-tree-panel">
      <input
        className="folder-search"
        type="text"
        placeholder="Buscar carpeta…"
        value={filter}
        onChange={(e: ChangeEvent<HTMLInputElement>) => setFilter(e.currentTarget.value)}
      />
      <div className="tree-container">{filteredTree ? renderNode(filteredTree) : null}</div>

      {showControls && (
        <>
          <div className="folder-buttons">
            <button onClick={() => (ref as any).current.createFolder()}>Crear</button>
            <button onClick={() => (ref as any).current.renameFolder()} disabled={selected.id === root?.id}>
              Renombrar
            </button>
            <button onClick={() => (ref as any).current.deleteFolder()} disabled={selected.id === root?.id}>
              Borrar
            </button>
          </div>

          <div className="folder-buttons" style={{ marginTop: 0 }}>
            <button
              onClick={() => setShowMoveFolder(true)}
              disabled={selected.id === root?.id}
              title="Mover carpeta seleccionada a otra carpeta"
            >
              Mover
            </button>
          </div>

          <MoveFolderDialog
            open={showMoveFolder}
            source={selected.id ? (selected as any) : null}
            onClose={() => setShowMoveFolder(false)}
            onAccept={async (target) => {
              await doMoveFolder(target);
              setShowMoveFolder(false);
            }}
          />
        </>
      )}
    </div>
  );
});

/* =========================
   Overlay (categorías en móvil)
   ========================= */
function Overlay({
  selected,
  onClose,
  onSelect,
  onOpen,
}: {
  selected: { id: number | null; name: string; guid?: string };
  onClose: () => void;
  onSelect: (f: { id: number; name: string; guid: string }) => void;
  onOpen: (f: { id: number; name: string; guid: string }) => void;
}) {
  const treeRef = useRef<FolderTreePanelHandle>(null);
  const [mode, setMode] = useState<"none" | "create" | "rename" | "delete" | "move">("none");
  const [inputValue, setInputValue] = useState("");

  const startCreate = () => {
    setInputValue("");
    setMode("create");
  };
  const confirmCreate = async () => {
    setMode("none");
    await treeRef.current?.createFolder(inputValue.trim());
  };

  const startRename = () => {
    setInputValue("");
    setMode("rename");
  };
  const confirmRename = async () => {
    setMode("none");
    await treeRef.current?.renameFolder(inputValue.trim());
  };

  const startDelete = () => setMode("delete");
  const startMove = () => setMode("move");
  const cancel = () => setMode("none");

  return (
    <div className="mobile-overlay">
      <button className="overlay-close" onClick={onClose} aria-label="Cerrar categorías">
        ×
      </button>

      <div className="overlay-tree">
        <FolderTreePanel
          ref={treeRef}
          selected={selected as any}
          onSelect={(f) => onSelect(f)}
          onOpen={(f) => onOpen(f)}
          showControls={false}
          skipInitialSelect
        />
      </div>

      {(mode === "create" || mode === "rename") && (
        <div className="overlay-modal" role="dialog" aria-modal="true">
          <div className="overlay-modal-card">
            <h3 className="overlay-modal-title">{mode === "create" ? "Nueva carpeta" : "Renombrar carpeta"}</h3>

            <input
              className="overlay-modal-input"
              placeholder={mode === "create" ? "Nombre de la carpeta" : "Nuevo nombre"}
              value={inputValue}
              onChange={(e) => setInputValue(e.currentTarget.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") (mode === "create" ? confirmCreate : confirmRename)();
                if (e.key === "Escape") cancel();
              }}
            />

            <div className="overlay-modal-actions">
              <button className="overlay-btn-primary" onClick={mode === "create" ? confirmCreate : confirmRename}>
                OK
              </button>
              <button className="overlay-btn-secondary" onClick={cancel}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {mode === "delete" && (
        <div className="overlay-modal" role="dialog" aria-modal="true">
          <div className="overlay-modal-card">
            <h3 className="overlay-modal-title">Borrar carpeta</h3>

            <p style={{ margin: "0 0 12px 0" }}>
              ¿Borrar <strong>“{selected.name}”</strong> y todo su contenido?
            </p>

            <div className="overlay-modal-actions">
              <button
                className="overlay-btn-danger"
                onClick={async () => {
                  setMode("none");
                  await treeRef.current?.deleteFolder({ force: true });
                }}
              >
                Borrar
              </button>
              <button className="overlay-btn-secondary" onClick={() => setMode("none")}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {mode === "move" && selected.id != null && selected.guid && (
        <MoveFolderDialog
          open
          source={{ id: selected.id, name: selected.name, guid: selected.guid }}
          onClose={() => setMode("none")}
          onAccept={async (target) => {
            if (target.id === selected.id) {
              alert("No puedes mover una carpeta dentro de sí misma.");
              return;
            }

            const r = await getRoot();
            if (selected.id === r.id) {
              alert("No puedes mover la carpeta raíz.");
              return;
            }

            const isDesc = await (async function isDescendant(
              candidateId: number,
              ancestorId: number
            ): Promise<boolean> {
              if (candidateId === ancestorId) return true;
              const kids = await listChildren(ancestorId);
              for (const k of kids) {
                if (k.id === candidateId) return true;
                if (await isDescendant(candidateId, k.id)) return true;
              }
              return false;
            })(target.id, selected.id!);

            if (isDesc) {
              alert("No puedes mover la carpeta a uno de sus descendientes.");
              return;
            }

            await moveFolderByGuids(selected.guid!, target.guid);
            await wsEmit({
              type: "move_folder",
              device_id: getDeviceId(),
              ts: new Date().toISOString(),
              payload: { folder_guid: selected.guid, new_parent_guid: target.guid },
            });

            setMode("none");
            emitSync();
            onSelect({ id: selected.id!, name: selected.name, guid: selected.guid! });
          }}
        />
      )}

      <div className="overlay-buttons">
        <button onClick={startCreate}>Crear</button>
        <button onClick={startRename} disabled={selected.id == null}>
          Renombrar
        </button>
        <button onClick={startDelete} disabled={selected.id == null}>
          Borrar
        </button>
      </div>

      <div className="overlay-buttons" style={{ marginTop: 8 }}>
        <button onClick={startMove} disabled={selected.id == null}>
          Mover
        </button>
      </div>
    </div>
  );
}

/* =========================
   RightPanel
   ========================= */
function RightPanel({
  searchText,
  onSearchChange,
  fontSize,
  onFontSizeChange,
  moveTo,
  onMoveToChange,
  onMoveUp,
  onMoveDown,
  onMoveSelected,
}: {
  searchText: string;
  onSearchChange: (txt: string) => void;
  fontSize: number;
  onFontSizeChange: (size: number) => void;
  moveTo: number;
  onMoveToChange: (pos: number) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onMoveSelected: () => void;
}) {
  // Dentro de RightPanel(...)
  return (
    <div className="control-panel">
      <label>Buscar texto:</label>
      <input
        type="text"
        value={searchText}
        onChange={(e) => onSearchChange(e.currentTarget.value)}
      />

      {/* NUEVA FILA: tamaño (mitad) + mover a la derecha */}
      <div className="size-move-row">
        <label className="size-label">Tamaño:</label>
        <input
          className="font-size-input"
          type="number"
          min={6}
          max={60}
          step={0.5}
          value={fontSize}
          onChange={(e) => onFontSizeChange(parseFloat(e.currentTarget.value))}
        />

        <div className="inline-move">
          <button onClick={onMoveUp} aria-label="Subir bloque">↑</button>
          <input
            className="move-index-input"
            type="number"
            min={1}
            value={moveTo}
            onChange={(e) => onMoveToChange(Math.max(1, +e.currentTarget.value))}
          />
          <button onClick={onMoveDown} aria-label="Bajar bloque">↓</button>
        </div>
      </div>

      {/* Botón Mover se queda abajo */}
      <button style={{ marginTop: 8 }} onClick={onMoveSelected}>
        Mover
      </button>
    </div>
  );
}

/* =========================
   App
   ========================= */
function App() {
  const [selectedFolder, setSelectedFolder] = useState<{ id: number | null; name: string; guid?: string }>({
    id: null,
    name: "categorias",
    guid: undefined,
  });
  const [fontSize, setFontSize] = useState<number>(14);
  const [searchText, setSearchText] = useState<string>("");
  const [moveTo, setMoveTo] = useState<number>(1);

  const [anchorIndex, setAnchorIndex] = useState<number>(1);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 600);
  const [showOverlay, setShowOverlay] = useState(false);

  const [showMove, setShowMove] = useState(false);

  const blockRef = useRef<BlockColumnHandle>(null);

  // 🔒 Anti “salto” por foco en iOS / webviews:
  useEffect(() => {
    // 1) Fijar scroll global arriba cuando un input/textarea recibe foco dentro de la app
    const onFocusIn = (ev: FocusEvent) => {
      const t = ev.target as HTMLElement | null;
      if (!t) return;
      const inApp = !!t.closest(".app-container");
      if (!inApp) return;

      // Evita que el navegador "desplace" el documento para mostrar el caret
      requestAnimationFrame(() => {
        window.scrollTo(0, 0);
      });
    };
    window.addEventListener("focusin", onFocusIn, { passive: true });

    // 2) Mantener una var CSS con la altura del viewport visual (si existe)
    const vv = (window as any).visualViewport as VisualViewport | undefined;
    const applyVVH = () => {
      if (!vv) return;
      document.documentElement.style.setProperty("--vvh", `${vv.height}px`);
    };
    applyVVH();
    vv?.addEventListener("resize", applyVVH);
    vv?.addEventListener("scroll", applyVVH);

    const onResize = () => setIsMobile(window.innerWidth <= 600);
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("focusin", onFocusIn as any);
      vv?.removeEventListener("resize", applyVVH);
      vv?.removeEventListener("scroll", applyVVH);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  // ✅ Inicio: intentar restaurar última carpeta usada si existe
  useEffect(() => {
    (async () => {
      await ensureWs();
      const r = await getRoot();

      const lastGuid = localStorage.getItem(LAST_FOLDER_GUID_KEY);
      if (lastGuid) {
        const lastId = await folderIdByGuid(lastGuid);
        if (lastId != null) {
          const fr = await findFolderRowById(lastId);
          if (fr) {
            setSelectedFolder({ id: fr.id, name: fr.name, guid: fr.guid! });
            console.log("[APP] última carpeta:", fr.name, fr.id);
            return;
          }
        }
      }

      setSelectedFolder({ id: r.id, name: r.name, guid: r.guid! });
      console.log("[APP] root lista:", r.name, r.id);
    })();
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      if (!ws) {
        void ensureWs();
      }
    }, 30_000);
    return () => clearInterval(t);
  }, []);

  // ✅ Persistir la carpeta seleccionada
  useEffect(() => {
    if (selectedFolder?.guid) {
      localStorage.setItem(LAST_FOLDER_GUID_KEY, selectedFolder.guid);
    }
  }, [selectedFolder?.guid]);

  // ✅ Al volver a la app: quitar foco de inputs/areas y restaurar última carpeta solo si difiere
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      void ensureWs();
      if (ws) { void sendHello(ws); }
      // ⬆️⬆️

      // restaurar carpeta si nos movieron a otra (ej. root por inactividad)
      const lastGuid = localStorage.getItem(LAST_FOLDER_GUID_KEY);
      if (lastGuid && lastGuid !== selectedFolder?.guid) {
        (async () => {
          const id = await folderIdByGuid(lastGuid);
          if (id != null) {
            const fr = await findFolderRowById(id);
            if (fr) setSelectedFolder({ id: fr.id, name: fr.name, guid: fr.guid! });
          }
        })();
      }

      // quitar foco de cualquier textarea/input para evitar teclado al volver
      const act = document.activeElement as HTMLElement | null;
      if (act && act.closest(".app-container") && (act.tagName === "TEXTAREA" || act.tagName === "INPUT")) {
        setTimeout(() => act.blur(), 0);
      }
    };

    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [selectedFolder?.guid]);

  const handleMoveUp = () => {
    const n = Number(anchorIndex);
    if (Number.isFinite(n) && n > 0) blockRef.current?.moveBlockRelativeTo(n, "above");
    else blockRef.current?.moveBlock(-1);
  };
  const handleMoveDown = () => {
    const n = Number(anchorIndex);
    if (Number.isFinite(n) && n > 0) blockRef.current?.moveBlockRelativeTo(n, "below");
    else blockRef.current?.moveBlock(1);
  };

  const openMoveDialog = () => setShowMove(true);
  const closeMoveDialog = () => setShowMove(false);

  const doMoveSelectedToFolder = async (target: { id: number; name: string; guid: string }) => {
    try {
      const items = blockRef.current?.getSelectedBlocks() ?? [];
      if (items.length === 0) {
        closeMoveDialog();
        return;
      }

      for (const it of items) {
        const block = await blockByGuid(it.guid);
        if (!block) continue;

        const sameFolder = selectedFolder.guid === target.guid;

        if (sameFolder) {
          const newPos = await getNextPositionInFolderByGuid(target.guid);
          await dbMoveBlock(block.id, newPos);
          await wsEmit({
            type: "move_block",
            device_id: getDeviceId(),
            ts: new Date().toISOString(),
            payload: { block_guid: block.guid, new_position: newPos },
          });
        } else {
          if (block.guid) {
            await dbMoveBlockToFolderEndByGuids(block.guid, target.guid); // ✅ protege null
            await wsEmit({
              type: "move_block_to_folder",
              device_id: getDeviceId(),
              ts: new Date().toISOString(),
              payload: {
                block_guid: block.guid,
                old_folder_guid: selectedFolder.guid,
                new_folder_guid: target.guid,
              },
            });
          }
        }
      }

      blockRef.current?.clearSelection();
      emitSync();
    } catch (e) {
      console.error("MoveSelected error:", e);
    } finally {
      closeMoveDialog();
    }
  };

  if (!selectedFolder.id) {
    return <div style={{ padding: 16, color: "#666" }}>Cargando…</div>;
  }

  if (!isMobile) {
    return (
      <div className="app-container">
        <div className="folder-panel">
          <FolderTreePanel
            selected={selectedFolder as { id: number; name: string; guid: string }}
            onSelect={(f) => setSelectedFolder(f)}
            onOpen={(f) => setSelectedFolder(f)}
          />
        </div>

        <div className="block-panel">
          {selectedFolder ? (
            <BlockColumn
              ref={blockRef}
              currentFolderId={selectedFolder.id!}
              currentFolderGuid={selectedFolder.guid!}
              fontSize={fontSize}
              searchText={searchText}
              moveTo={moveTo}
              onFocusChange={(idx) => {
                setMoveTo(idx + 1);
              }}
            />
          ) : (
            <p style={{ padding: 16, color: "#666" }}>Selecciona una carpeta a la izquierda…</p>
          )}
        </div>

        <div className="control-panel">
          <RightPanel
            searchText={searchText}
            onSearchChange={setSearchText}
            fontSize={fontSize}
            onFontSizeChange={setFontSize}
            moveTo={moveTo}
            onMoveToChange={setMoveTo}
            onMoveUp={handleMoveUp}
            onMoveDown={handleMoveDown}
            onMoveSelected={openMoveDialog}
          />
        </div>

        <MoveDialog
          open={showMove}
          initialFolder={selectedFolder as any}
          onClose={closeMoveDialog}
          onAccept={doMoveSelectedToFolder}
        />
      </div>
    );
  }

  return (
    <div className="app-container mobile">
      {showOverlay && (
        <Overlay
          selected={selectedFolder}
          onClose={() => setShowOverlay(false)}
          onSelect={(f) => setSelectedFolder(f)}
          onOpen={(f) => {
            setSelectedFolder(f);
            setShowOverlay(false);
          }}
        />
      )}

      <MoveDialog
        open={showMove}
        initialFolder={selectedFolder as any}
        onClose={() => setShowMove(false)}
        onAccept={doMoveSelectedToFolder}
      />

      <div className="mobile-header">
        <button className="mobile-categories-btn" onClick={() => setShowOverlay(true)}>
          CATEGORÍAS
        </button>
        <h1 className="mobile-cat-title">{(selectedFolder.name || "").toUpperCase()}</h1>
      </div>

      <div className="mobile-font-row">
        <label className="mobile-size-label">Tamaño:</label>

        <input
          className="mobile-font-size-input"
          type="number"
          min={6}
          max={60}
          step={0.5}
          value={fontSize}
          onChange={(e) => setFontSize(parseFloat(e.currentTarget.value))}
        />

        {/* ⟶ los 3 controles (↑ # ↓) a la derecha */}
        <div className="mobile-inline-move">
          <button onClick={handleMoveUp} aria-label="Subir bloque">↑</button>
          <input
            className="mobile-move-input"
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={anchorIndex}
            onChange={(e) => setAnchorIndex(Number(e.currentTarget.value || 1))}
          />
          <button onClick={handleMoveDown} aria-label="Bajar bloque">↓</button>
        </div>
      </div>

      <input
        className="mobile-search-text"
        placeholder="Buscar texto..."
        value={searchText}
        onChange={(e) => setSearchText(e.currentTarget.value)}
      />

      <div className="mobile-blocks-list">
        <BlockColumn
          ref={blockRef}
          currentFolderId={selectedFolder.id!}
          currentFolderGuid={selectedFolder.guid!}
          fontSize={fontSize}
          searchText={searchText}
          moveTo={moveTo}
          onFocusChange={(idx) => {
            setMoveTo(idx + 1);
          }}
        />
      </div>

      <div style={{ padding: "8px 12px" }}>
        <button style={{ width: "100%" }} onClick={() => setShowMove(true)}>
          Mover
        </button>
      </div>
    </div>
  );
}

/* =========================
   bootstrap
   ========================= */
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
