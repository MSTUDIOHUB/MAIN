/**
 * Detect a sampling loop inside one visible stream.  This is deliberately
 * independent from tool-call repetition: a provider can keep emitting prose
 * forever without producing another tool call or an idle-stream timeout.
 */
export interface VisibleTextRepetitionMatch {
  repetitions: number;
  unitCount: number;
  cycleChars: number;
}

const MIN_REPETITIONS = 3;
const MIN_CYCLE_CHARS = 120;
const MAX_TRAILING_UNITS = 96;
const MAX_CYCLE_UNITS = 12;

function normalizeUnit(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function splitVisibleTextIntoUnits(value: string): string[] {
  // Preserve line-oriented model output while also handling prose streams that
  // never insert paragraph breaks.  The punctuation replacement avoids a
  // lookbehind regex so this stays portable across desktop runtimes.
  return value
    .replace(/\r/g, "")
    .replace(/([.!?。！？])\s*/g, "$1\n")
    .split(/\n+/)
    .map(normalizeUnit)
    .filter((unit) => unit.length >= 12)
    .slice(-MAX_TRAILING_UNITS);
}

/**
 * Returns a match only when the trailing semantic block has been emitted at
 * least three times consecutively.  Short acknowledgements are ignored, and
 * the bounded unit window keeps this safe to run after every stream delta.
 */
export function detectVisibleTextRepetition(value: string): VisibleTextRepetitionMatch | null {
  const units = splitVisibleTextIntoUnits(value);
  const maxWidth = Math.min(MAX_CYCLE_UNITS, Math.floor(units.length / MIN_REPETITIONS));
  for (let width = 1; width <= maxWidth; width += 1) {
    const cycle = units.slice(-width);
    const cycleText = cycle.join("\n");
    if (cycleText.length < MIN_CYCLE_CHARS) continue;
    let matches = true;
    for (let repeat = 2; repeat <= MIN_REPETITIONS; repeat += 1) {
      const previous = units.slice(-width * repeat, -width * (repeat - 1));
      if (previous.length !== width || previous.join("\n") !== cycleText) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return {
        repetitions: MIN_REPETITIONS,
        unitCount: width,
        cycleChars: cycleText.length,
      };
    }
  }
  return null;
}
