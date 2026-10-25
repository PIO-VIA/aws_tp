import { describe, it, expect, vi } from "vitest";
import { scanAll } from "@shared/aws/dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

describe("C-06 — T1 (unitaire) : scanAll pagine correctement sur LastEvaluatedKey", () => {
  it("scanAll retourne tous les éléments à travers 3 pages de résultats", async () => {
    const page1Items = [{ id: "1" }, { id: "2" }];
    const page2Items = [{ id: "3" }, { id: "4" }];
    const page3Items = [{ id: "5" }];

    let callCount = 0;
    const sentCommands: unknown[] = [];

    const fakeDocClient = {
      send: vi.fn().mockImplementation(async (command: { input: { TableName: string; ExclusiveStartKey?: unknown } }) => {
        callCount++;
        sentCommands.push(command);
        if (callCount === 1) {
          return {
            Items: page1Items,
            LastEvaluatedKey: { id: "2" },
          };
        } else if (callCount === 2) {
          return {
            Items: page2Items,
            LastEvaluatedKey: { id: "4" },
          };
        } else {
          return {
            Items: page3Items,
            LastEvaluatedKey: undefined,
          };
        }
      }),
    };

    const results = await scanAll(
      {
        TableName: "test-table",
      },
      fakeDocClient as unknown as DynamoDBDocumentClient,
    );

    expect(callCount).toBe(3);
    expect(results).toEqual([
      { id: "1" },
      { id: "2" },
      { id: "3" },
      { id: "4" },
      { id: "5" },
    ]);

    // Vérifier que ExclusiveStartKey a bien été passé aux pages 2 et 3
    const cmd1 = sentCommands[0] as { input: { ExclusiveStartKey?: unknown } };
    const cmd2 = sentCommands[1] as { input: { ExclusiveStartKey?: unknown } };
    const cmd3 = sentCommands[2] as { input: { ExclusiveStartKey?: unknown } };

    expect(cmd1.input.ExclusiveStartKey).toBeUndefined();
    expect(cmd2.input.ExclusiveStartKey).toEqual({ id: "2" });
    expect(cmd3.input.ExclusiveStartKey).toEqual({ id: "4" });
  });

  it("scanAll retourne un tableau vide si aucun item n'existe", async () => {
    const fakeDocClient = {
      send: vi.fn().mockResolvedValue({
        Items: undefined,
        LastEvaluatedKey: undefined,
      }),
    };

    const results = await scanAll(
      {
        TableName: "empty-table",
      },
      fakeDocClient as unknown as DynamoDBDocumentClient,
    );

    expect(results).toEqual([]);
  });
});
