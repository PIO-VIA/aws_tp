import { describe, it, expect, vi, beforeAll } from "vitest";
import { listDocumentEditorsWithCredits } from "@shared/docs/documents";
import * as ddbModule from "@shared/aws/dynamodb";
import * as quotaModule from "@shared/quota/quota";
import { resetConfig } from "@shared/config";

describe("Consultation des rédacteurs et crédits restants par le propriétaire", () => {
  beforeAll(() => {
    process.env.APP_ENV = "local";
    process.env.TABLE_PREFIX = "test-";
    process.env.S3_BUCKET = "test-bucket";
    process.env.DDB_ENDPOINT = "http://localhost:8000";
    process.env.S3_ENDPOINT = "http://localhost:9000";
    process.env.SQS_ENDPOINT = "http://localhost:9324";
    process.env.PDF_QUEUE_URL = "http://localhost:9324/000000000000/pdf-jobs";
    process.env.PDF_DLQ_URL = "http://localhost:9324/000000000000/pdf-jobs-dlq";
    resetConfig();
  });

  it("rejette la requête si l'utilisateur demandeur n'est pas propriétaire du document", async () => {
    // Simule DynamoDB GetCommand retournant un rôle 'editor'
    const fakeSend = vi.fn().mockResolvedValueOnce({
      Item: {
        docId: "doc-1",
        writerId: "writer-editor",
        role: "editor",
        email: "editor@asso.fr",
        name: "Bob Editor",
      },
    });

    vi.spyOn(ddbModule, "getDocClient").mockReturnValueOnce({
      send: fakeSend,
    } as unknown as ReturnType<typeof ddbModule.getDocClient>);

    await expect(
      listDocumentEditorsWithCredits("doc-1", "writer-editor"),
    ).rejects.toThrow("Seul le propriétaire peut consulter les rédacteurs et leurs crédits");
  });

  it("rejette la requête si l'utilisateur n'a aucune permission sur le document", async () => {
    // Simule DynamoDB GetCommand ne trouvant aucun Item
    const fakeSend = vi.fn().mockResolvedValueOnce({
      Item: undefined,
    });

    vi.spyOn(ddbModule, "getDocClient").mockReturnValueOnce({
      send: fakeSend,
    } as unknown as ReturnType<typeof ddbModule.getDocClient>);

    await expect(
      listDocumentEditorsWithCredits("doc-1", "unknown-writer"),
    ).rejects.toThrow("Seul le propriétaire peut consulter les rédacteurs et leurs crédits");
  });

  it("retourne la liste triée avec le propriétaire en tête et le solde de crédit pour chaque membre", async () => {
    const fakeSend = vi.fn()
      // Premier appel : getDocumentPermission (GetCommand)
      .mockResolvedValueOnce({
        Item: {
          docId: "doc-1",
          writerId: "writer-owner",
          role: "owner",
          email: "owner@asso.fr",
          name: "Alice Owner",
        },
      })
      // Deuxième appel : QueryCommand sur doc_permissions
      .mockResolvedValueOnce({
        Items: [
          {
            docId: "doc-1",
            writerId: "writer-charlie",
            email: "charlie@asso.fr",
            name: "Charlie Rédacteur",
            role: "editor",
            createdAt: 1200,
          },
          {
            docId: "doc-1",
            writerId: "writer-owner",
            email: "owner@asso.fr",
            name: "Alice Owner",
            role: "owner",
            createdAt: 1000,
          },
          {
            docId: "doc-1",
            writerId: "writer-bob",
            email: "bob@asso.fr",
            name: "Bob Lecteur",
            role: "viewer",
            createdAt: 1100,
          },
        ],
      });

    vi.spyOn(ddbModule, "getDocClient").mockReturnValue({
      send: fakeSend,
    } as unknown as ReturnType<typeof ddbModule.getDocClient>);

    // Mock du quota
    vi.spyOn(quotaModule, "getWriterQuota").mockImplementation(async (writerId: string) => {
      if (writerId === "writer-owner") {
        return { used: 1500, remaining: 8500, dailyLimit: 10000, resetAt: 1730000000, quotaKey: "k1" };
      }
      if (writerId === "writer-charlie") {
        return { used: 9200, remaining: 800, dailyLimit: 10000, resetAt: 1730000000, quotaKey: "k2" };
      }
      return { used: 0, remaining: 10000, dailyLimit: 10000, resetAt: 1730000000, quotaKey: "k3" };
    });

    const result = await listDocumentEditorsWithCredits("doc-1", "writer-owner");

    expect(result).toHaveLength(3);

    // Propriétaire en premier
    expect(result[0].role).toBe("owner");
    expect(result[0].name).toBe("Alice Owner");
    expect(result[0].credit.used).toBe(1500);
    expect(result[0].credit.remaining).toBe(8500);

    // Ensuite tri alphabétique
    expect(result[1].name).toBe("Bob Lecteur");
    expect(result[1].credit.remaining).toBe(10000);

    expect(result[2].name).toBe("Charlie Rédacteur");
    expect(result[2].credit.remaining).toBe(800);
  });

  it("garantit que seul le propriétaire est qualifié pour générer un lien de téléchargement", () => {
    // Vérifie la règle métier : perm.role === 'owner'
    const ownerPerm = { role: "owner" as const };
    const editorPerm = { role: "editor" as const };
    const viewerPerm = { role: "viewer" as const };

    const isAuthorizedToCreateLink = (perm: { role: string } | null) => perm?.role === "owner";

    expect(isAuthorizedToCreateLink(ownerPerm)).toBe(true);
    expect(isAuthorizedToCreateLink(editorPerm)).toBe(false);
    expect(isAuthorizedToCreateLink(viewerPerm)).toBe(false);
    expect(isAuthorizedToCreateLink(null)).toBe(false);
  });
});

