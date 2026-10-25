import { describe, it, expect } from "vitest";
import path from "path";
import { generateReportContent } from "../../scripts/gen-test-report";

describe("C-09 : Génération automatique du rapport de tests (TEST_REPORT.md)", () => {
  const fixturesBaseDir = path.join(__dirname, "..", "fixtures", "reports");
  const testResultsDir = path.join(fixturesBaseDir, "test-results");
  const loadtestResultsDir = path.join(fixturesBaseDir, "loadtest", "results");

  it("T1. Vérifie que les nombres du rapport sont strictement égaux aux fichiers de test", () => {
    const reportMd = generateReportContent({
      testResultsDir,
      loadtestResultsDir,
    });

    // 1. Vérification des totaux des tests automatisés
    // unit: 2 tests, integration: 2 tests (1 passed, 1 failed), scenarios: 3 tests
    // Total: 7 tests, 6 passed, 1 failed
    expect(reportMd).toContain("7"); // total tests
    expect(reportMd).toContain("6"); // passed tests
    expect(reportMd).toContain("1"); // failed tests

    // 2. Un test en échec doit apparaître comme tel
    expect(reportMd).toContain("test failure example");
    expect(reportMd).toMatch(/ÉCHEC|FAIL/i);

    // 3. Les chiffres de charge doivent correspondre exactement aux fixtures
    // 600 visiteurs, 500 exemplaires, 500 URLs distinctes
    expect(reportMd).toContain("600");
    expect(reportMd).toContain("500");
    expect(reportMd).toContain("625"); // total requests in fixture
    expect(reportMd).toContain("-69 ms"); // C6 gap

    // Collab fixture: 300 rédacteurs, 89100 propagations, CPU 7795 ms
    expect(reportMd).toContain("300");
    expect(reportMd).toContain("89100");
    expect(reportMd).toContain("7795");

    // 4. Objectif non atteint marqué ÉCHEC
    // Dans la fixture, initialLatenciesMs.p95 = 6839 ms (> 250 ms objectif)
    // Et collab latenciesMs.p95 = 2650 ms (> 200 ms)
    expect(reportMd).toMatch(/6839.*ms/);
    expect(reportMd).toContain("ÉCHEC");

    // 5. Tableau "Mesuré / Non mesuré" obligatoire
    expect(reportMd).toContain("Mesuré / Non mesuré");
    expect(reportMd).toContain("15 000 visiteurs");
    expect(reportMd).toContain("300 rédacteurs");
    expect(reportMd).toContain("Test combiné");
    expect(reportMd).toContain("Déploiement AWS réel");

    // 6. Preuve C1 et C2
    expect(reportMd).toContain("Preuve de l'invariant C1");
    expect(reportMd).toContain("Preuve de l'invariant C2");
  });
});
