/**
 * Décodage et validation stricte des mises à jour Yjs (Section 7.3).
 *
 * Seules les structures de contenu texte (ContentString) et supprimées
 * (ContentDeleted / GC / Skip) sont autorisées, rattachées au type racine "content".
 * Tout autre contenu (embed, format, array, map, binary) est rejeté comme invalide.
 */
import * as Y from "yjs";
import { IntervalSet } from "./interval-set";

export interface ParseUpdateResult {
  valid: boolean;
  reason?: "invalid_update" | "too_large" | "unsupported_type" | "corrupt";
  newChars: number;
  totalLength: number;
  isEmpty?: boolean;
}

/**
 * Valide un update Yjs brut et calcule le nombre de nouveaux caractères UTF-16 insérés.
 * Si intervalSet est fourni, les unités déjà facturées ne sont pas recomptabilisées (idempotence I06).
 */
export function parseAndValidateUpdate(
  updateBytes: Uint8Array,
  intervalSet?: IntervalSet,
  commitIntervals = false,
): ParseUpdateResult {
  let decoded: ReturnType<typeof Y.decodeUpdate>;
  try {
    decoded = Y.decodeUpdate(updateBytes);
  } catch {
    return {
      valid: false,
      reason: "corrupt",
      newChars: 0,
      totalLength: 0,
    };
  }

  let newChars = 0;
  let totalLength = 0;

  for (const struct of decoded.structs) {
    if (struct instanceof Y.GC || struct instanceof Y.Skip) {
      // Éléments supprimés ou compactés -> aucun nouveau caractère
      continue;
    }

    const item = struct as Y.Item;

    // 1. Vérification du parent : doit être rattaché au Y.Text "content"
    const parent = item.parent;
    if (typeof parent === "string") {
      if (parent !== "content") {
        return {
          valid: false,
          reason: "unsupported_type",
          newChars: 0,
          totalLength: 0,
        };
      }
    }

    const content = item.content as unknown as Record<string, unknown>;

    // 2. Vérification des types de contenu autorisés
    if ("str" in content && typeof content.str === "string") {
      // ContentString valide
      const strLen = item.length; // longueur en unités UTF-16
      totalLength += strLen;

      if (intervalSet) {
        if (commitIntervals) {
          newChars += intervalSet.calculateNewAndAdd(item.id.client, item.id.clock, strLen);
        } else {
          // Simulation sans commit (lecture seule)
          const reqStart = item.id.clock;
          const reqEnd = item.id.clock + strLen;
          let covered = 0;
          for (const iv of intervalSet.getIntervals(item.id.client)) {
            const overlapStart = Math.max(reqStart, iv.start);
            const overlapEnd = Math.min(reqEnd, iv.end);
            if (overlapStart < overlapEnd) {
              covered += overlapEnd - overlapStart;
            }
          }
          newChars += Math.max(0, strLen - covered);
        }
      } else {
        newChars += strLen;
      }
    } else if ("len" in content && typeof content.len === "number") {
      // ContentDeleted ou Skip -> gratuit
      continue;
    } else {
      // embed, format, arr, type, doc, binary -> interdit !
      return {
        valid: false,
        reason: "invalid_update",
        newChars: 0,
        totalLength: 0,
      };
    }
  }

  const hasDeletions = decoded.ds.clients ? decoded.ds.clients.size > 0 : false;
  const isEmpty = decoded.structs.length === 0 && !hasDeletions;

  return {
    valid: true,
    newChars,
    totalLength,
    isEmpty,
  };
}
