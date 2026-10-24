import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { parseAndValidateUpdate } from "@shared/yjs/message-parser";
import { IntervalSet } from "@shared/yjs/interval-set";

describe("MessageParser — Validation et comptage UTF-16 (D-07, Section 7.3)", () => {
  it("valide une insertion de texte simple et compte exactement les caractères", () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, "Bonjour");

    const update = Y.encodeStateAsUpdate(doc);
    const result = parseAndValidateUpdate(update);

    expect(result.valid).toBe(true);
    expect(result.newChars).toBe(7);
    expect(result.totalLength).toBe(7);
  });

  it("compte fidèlement les emojis en 2 unités UTF-16 (D-07)", () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    // "Salut " (6) + "🚀" (2) + " !" (2) = 10
    const str = "Salut 🚀 !";
    expect(str.length).toBe(10);

    text.insert(0, str);
    const update = Y.encodeStateAsUpdate(doc);
    const result = parseAndValidateUpdate(update);

    expect(result.valid).toBe(true);
    expect(result.newChars).toBe(10);
  });

  it("ne facture aucune unité pour les suppressions (D-07)", () => {
    const doc1 = new Y.Doc();
    doc1.getText("content").insert(0, "Bonjour à tous");

    const doc2 = new Y.Doc();
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

    // Suppression de 5 caractères
    doc2.getText("content").delete(0, 5);
    const delUpdate = Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1));

    const result = parseAndValidateUpdate(delUpdate);
    expect(result.valid).toBe(true);
    expect(result.newChars).toBe(0);
  });

  it("garantit la gratuité des retransmissions via IntervalSet (idempotence I06)", () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "Édition collaborative");

    const update = Y.encodeStateAsUpdate(doc);
    const set = new IntervalSet();

    // Première réception avec commit
    const first = parseAndValidateUpdate(update, set, true);
    expect(first.valid).toBe(true);
    expect(first.newChars).toBe("Édition collaborative".length);

    // Retransmission du même update
    const second = parseAndValidateUpdate(update, set, true);
    expect(second.valid).toBe(true);
    expect(second.newChars).toBe(0); // Gratuit !
  });

  it("rejette tout contenu enrichi ou embed (D-01, Section 7.3.3)", () => {
    const doc = new Y.Doc();
    doc.getText("content").insertEmbed(0, { link: "http://malicious.com" });

    const update = Y.encodeStateAsUpdate(doc);
    const result = parseAndValidateUpdate(update);

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("invalid_update");
  });

  it("rejette toute structure ciblant un type autre que le Y.Text 'content'", () => {
    const doc = new Y.Doc();
    doc.getMap("metadata").set("author", "hacker");

    const update = Y.encodeStateAsUpdate(doc);
    const result = parseAndValidateUpdate(update);

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("unsupported_type");
  });

  it("identifie les mises à jour vides (handshake initial de synchronisation)", () => {
    // Mise à jour vide [0, 0]
    const emptyUpdate = new Uint8Array([0, 0]);
    const result = parseAndValidateUpdate(emptyUpdate);

    expect(result.valid).toBe(true);
    expect(result.isEmpty).toBe(true);
    expect(result.newChars).toBe(0);
    expect(result.totalLength).toBe(0);
  });

  it("rejette les octets corrompus", () => {
    const corruptBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const result = parseAndValidateUpdate(corruptBytes);

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("corrupt");
  });
});
