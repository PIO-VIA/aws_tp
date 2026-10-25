import { describe, it, expect } from "vitest";
import { generateOpenLoopSchedule, calculateC6GapMs } from "../../loadtest/scheduler";

describe("C-08 — T1 (unitaire) : Planificateur en boucle ouverte et invariants de charge", () => {
  it("génère un profil en boucle ouverte avec 80% dans la 1ère minute et 20% dans les 4 minutes suivantes", () => {
    const totalVisitors = 1000;
    const schedule = generateOpenLoopSchedule({
      totalVisitors,
      burstRatio: 0.8,
      phase1Sec: 60,
      phase2Sec: 240,
      timeScale: 1,
    });

    expect(schedule.length).toBe(1000);

    // 800 visiteurs dans la première phase (0 à 60s)
    const phase1 = schedule.filter((s) => s.offsetMs < 60000);
    expect(phase1.length).toBe(800);

    // 200 visiteurs dans la deuxième phase (60s à 300s)
    const phase2 = schedule.filter((s) => s.offsetMs >= 60000);
    expect(phase2.length).toBe(200);

    // Dernier visiteur à moins de 300s (300000ms)
    expect(schedule[schedule.length - 1].offsetMs).toBeLessThanOrEqual(300000);

    // Ordonnancement strictement croissant
    for (let i = 1; i < schedule.length; i++) {
      expect(schedule[i].offsetMs).toBeGreaterThanOrEqual(schedule[i - 1].offsetMs);
    }
  });

  it("applique correctement la compression de temps via timeScale", () => {
    const totalVisitors = 100;
    const timeScale = 10; // 300s -> 30s
    const schedule = generateOpenLoopSchedule({
      totalVisitors,
      burstRatio: 0.8,
      phase1Sec: 60,
      phase2Sec: 240,
      timeScale,
    });

    expect(schedule.length).toBe(100);

    // Phase 1 : 60s / 10 = 6s = 6000ms
    const phase1 = schedule.filter((s) => s.offsetMs < 6000);
    expect(phase1.length).toBe(80);

    // Dernier visiteur à moins de 30s (30000ms)
    expect(schedule[schedule.length - 1].offsetMs).toBeLessThanOrEqual(30000);
  });

  it("calcule avec exactitude l'intervalle C6 entre le dernier exemplaire émis et le premier refus exhausted", () => {
    const grantedTimestamps = [1000, 1050, 1100, 1200, 1250];
    const exhaustedTimestamps = [1265, 1270, 1300];

    const gapMs = calculateC6GapMs(grantedTimestamps, exhaustedTimestamps);
    // Dernier granted: 1250, Premier exhausted: 1265 -> Gap = 15 ms
    expect(gapMs).toBe(15);
  });

  it("gère les cas limites de calculateC6GapMs sans granted ou sans exhausted", () => {
    expect(calculateC6GapMs([], [1000])).toBeNull();
    expect(calculateC6GapMs([1000], [])).toBeNull();
  });
});
