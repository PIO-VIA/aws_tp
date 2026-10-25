export interface ScheduledVisitor {
  visitorIndex: number;
  offsetMs: number;
  phase: "burst" | "tail";
}

export interface OpenLoopScheduleParams {
  totalVisitors: number;
  burstRatio?: number; // Défaut 0.8 (80%)
  phase1Sec?: number; // Défaut 60s
  phase2Sec?: number; // Défaut 240s
  timeScale?: number; // Défaut 1 (facteur de compression)
}

/**
 * Planificateur en boucle ouverte (C-08) :
 * 80% des visiteurs répartis uniformément sur les 60 premières secondes,
 * 20% sur les 240 secondes suivantes.
 * Facteur de compression timeScale pour exécution locale accélérée.
 */
export function generateOpenLoopSchedule(params: OpenLoopScheduleParams): ScheduledVisitor[] {
  const {
    totalVisitors,
    burstRatio = 0.8,
    phase1Sec = 60,
    phase2Sec = 240,
    timeScale = 1,
  } = params;

  const burstCount = Math.floor(totalVisitors * burstRatio);
  const tailCount = totalVisitors - burstCount;

  const schedule: ScheduledVisitor[] = [];

  // Phase 1 : 80% répartis uniformément de t = 0 à phase1Sec
  for (let i = 0; i < burstCount; i++) {
    const rawOffsetSec = (i / burstCount) * phase1Sec;
    const scaledOffsetMs = Math.round((rawOffsetSec * 1000) / timeScale);
    schedule.push({
      visitorIndex: i,
      offsetMs: scaledOffsetMs,
      phase: "burst",
    });
  }

  // Phase 2 : 20% répartis uniformément de t = phase1Sec à (phase1Sec + phase2Sec)
  for (let j = 0; j < tailCount; j++) {
    const rawOffsetSec = phase1Sec + (j / tailCount) * phase2Sec;
    const scaledOffsetMs = Math.round((rawOffsetSec * 1000) / timeScale);
    schedule.push({
      visitorIndex: burstCount + j,
      offsetMs: scaledOffsetMs,
      phase: "tail",
    });
  }

  return schedule.sort((a, b) => a.offsetMs - b.offsetMs);
}

/**
 * Calcule l'intervalle C6 entre le dernier exemplaire émis (granted)
 * et le premier refus poli pour épuisement (exhausted).
 */
export function calculateC6GapMs(
  grantedTimestamps: number[],
  exhaustedTimestamps: number[],
): number | null {
  if (grantedTimestamps.length === 0 || exhaustedTimestamps.length === 0) {
    return null;
  }
  const lastGranted = Math.max(...grantedTimestamps);
  const firstExhausted = Math.min(...exhaustedTimestamps);
  return firstExhausted - lastGranted;
}
