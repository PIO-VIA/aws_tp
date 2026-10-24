/**
 * IntervalSet : structure de suivi des intervalles d'horloges Yjs [start, end)
 * par clientID pour garantir l'idempotence stricte (I06) et la facturation
 * exacte des caractères insérés (D-07, Section 7.3).
 */
import * as Y from "yjs";

export interface Interval {
  start: number;
  end: number;
}

export class IntervalSet {
  private sets = new Map<number, Interval[]>();

  /**
   * Retourne une copie des intervalles pour un clientID donné.
   */
  getIntervals(clientId: number): readonly Interval[] {
    return this.sets.get(clientId) ?? [];
  }

  /**
   * Calcule le nombre d'unités nouvelles dans [clock, clock + len) et
   * intègre l'intervalle dans l'ensemble (fusion des chevauchements).
   */
  calculateNewAndAdd(clientId: number, clock: number, len: number): number {
    if (len <= 0) return 0;
    const reqStart = clock;
    const reqEnd = clock + len;

    const current = this.sets.get(clientId) ?? [];
    if (current.length === 0) {
      this.sets.set(clientId, [{ start: reqStart, end: reqEnd }]);
      return len;
    }

    // 1. Calcul du nombre d'unités nouvelles
    let covered = 0;
    for (const iv of current) {
      const overlapStart = Math.max(reqStart, iv.start);
      const overlapEnd = Math.min(reqEnd, iv.end);
      if (overlapStart < overlapEnd) {
        covered += overlapEnd - overlapStart;
      }
    }
    const newUnits = Math.max(0, len - covered);

    // 2. Fusion et mise à jour des intervalles disjoints triés
    const newIntervals: Interval[] = [];
    let mergedStart = reqStart;
    let mergedEnd = reqEnd;
    let inserted = false;

    for (const iv of current) {
      if (iv.end < mergedStart) {
        // Strictement avant
        newIntervals.push(iv);
      } else if (iv.start > mergedEnd) {
        // Strictement après
        if (!inserted) {
          newIntervals.push({ start: mergedStart, end: mergedEnd });
          inserted = true;
        }
        newIntervals.push(iv);
      } else {
        // Chevauchement ou contiguïté -> on élargit
        mergedStart = Math.min(mergedStart, iv.start);
        mergedEnd = Math.max(mergedEnd, iv.end);
      }
    }

    if (!inserted) {
      newIntervals.push({ start: mergedStart, end: mergedEnd });
    }

    this.sets.set(clientId, newIntervals);
    return newUnits;
  }

  /**
   * Ajoute un intervalle sans retourner le compte de nouveautés.
   */
  add(clientId: number, clock: number, len: number): void {
    this.calculateNewAndAdd(clientId, clock, len);
  }

  /**
   * Vérifie si une horloge spécifique est déjà couverte.
   */
  contains(clientId: number, clock: number): boolean {
    const intervals = this.sets.get(clientId);
    if (!intervals) return false;
    for (const iv of intervals) {
      if (clock >= iv.start && clock < iv.end) return true;
      if (iv.start > clock) break;
    }
    return false;
  }

  /**
   * Initialise l'IntervalSet à partir du State Vector d'un Y.Doc.
   * Tout ce qui est déjà intégré dans le document est considéré facturé [0, clock).
   */
  static fromYDoc(ydoc: Y.Doc): IntervalSet {
    const set = new IntervalSet();
    const sv = Y.encodeStateVector(ydoc);
    const decoded = Y.decodeStateVector(sv);

    for (const [clientId, clock] of decoded.entries()) {
      if (clock > 0) {
        set.add(clientId, 0, clock);
      }
    }
    return set;
  }

  /**
   * Initialise depuis une Map<number, number> de state vector.
   */
  static fromStateVectorMap(sv: Map<number, number>): IntervalSet {
    const set = new IntervalSet();
    for (const [clientId, clock] of sv.entries()) {
      if (clock > 0) {
        set.add(clientId, 0, clock);
      }
    }
    return set;
  }
}
