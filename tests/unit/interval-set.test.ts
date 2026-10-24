import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { IntervalSet } from "@shared/yjs/interval-set";

describe("IntervalSet — Idempotence et détection des nouveautés (I06, D-07)", () => {
  it("calcule correctement les nouvelles unités pour une insertion simple", () => {
    const set = new IntervalSet();
    const newUnits = set.calculateNewAndAdd(1, 0, 10);
    expect(newUnits).toBe(10);
    expect(set.getIntervals(1)).toEqual([{ start: 0, end: 10 }]);
  });

  it("gère une retransmission exacte sans facturation (idempotence stricte I06)", () => {
    const set = new IntervalSet();
    set.add(1, 0, 10);

    const retransmittedUnits = set.calculateNewAndAdd(1, 0, 10);
    expect(retransmittedUnits).toBe(0);
    expect(set.getIntervals(1)).toEqual([{ start: 0, end: 10 }]);
  });

  it("gère un chevauchement partiel (début ou fin)", () => {
    const set = new IntervalSet();
    set.add(1, 0, 10); // [0, 10)

    // Chevauchement à la suite : [5, 15) -> 5 unités nouvelles [10, 15)
    const newUnits = set.calculateNewAndAdd(1, 5, 10);
    expect(newUnits).toBe(5);
    expect(set.getIntervals(1)).toEqual([{ start: 0, end: 15 }]);
  });

  it("fusionne deux intervalles disjoints avec un pont qui les relie", () => {
    const set = new IntervalSet();
    set.add(1, 0, 10); // [0, 10)
    set.add(1, 20, 10); // [20, 30)
    expect(set.getIntervals(1)).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 30 },
    ]);

    // Pont reliant les deux : [8, 22) -> unités nouvelles dans [10, 20) = 10 unités
    const bridgeUnits = set.calculateNewAndAdd(1, 8, 14);
    expect(bridgeUnits).toBe(10);
    expect(set.getIntervals(1)).toEqual([{ start: 0, end: 30 }]);
  });

  it("gère l'ordre d'arrivée inversé", () => {
    const set = new IntervalSet();
    set.add(1, 20, 10); // [20, 30)
    set.add(1, 0, 10); // [0, 10)

    expect(set.getIntervals(1)).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 30 },
    ]);

    // Insertion contiguë
    const adj = set.calculateNewAndAdd(1, 10, 10); // [10, 20)
    expect(adj).toBe(10);
    expect(set.getIntervals(1)).toEqual([{ start: 0, end: 30 }]);
  });

  it("isole rigoureusement les clientIDs distincts", () => {
    const set = new IntervalSet();
    set.add(100, 0, 10);
    set.add(200, 0, 15);

    expect(set.getIntervals(100)).toEqual([{ start: 0, end: 10 }]);
    expect(set.getIntervals(200)).toEqual([{ start: 0, end: 15 }]);

    // Ajout sur client 100 n'affecte pas client 200
    const units100 = set.calculateNewAndAdd(100, 5, 10);
    expect(units100).toBe(5);
    expect(set.getIntervals(200)).toEqual([{ start: 0, end: 15 }]);
  });

  it("initialise l'IntervalSet depuis un Y.Doc existant", () => {
    const ydoc = new Y.Doc();
    const text = ydoc.getText("content");
    text.insert(0, "Bonjour le monde !");

    const set = IntervalSet.fromYDoc(ydoc);
    // Tout ce qui est dans le document est déjà facturé
    for (const [clientId, clock] of Y.decodeStateVector(Y.encodeStateVector(ydoc)).entries()) {
      expect(set.contains(clientId, 0)).toBe(true);
      expect(set.contains(clientId, clock - 1)).toBe(true);
      expect(set.contains(clientId, clock)).toBe(false);
      // Retransmission intégrale
      expect(set.calculateNewAndAdd(clientId, 0, clock)).toBe(0);
    }
  });
});
