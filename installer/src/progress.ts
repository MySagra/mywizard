import { spinner } from "@clack/prompts";
import pc from "picocolors";

/**
 * Progress reporter used while the stack starts.
 *
 * In interactive mode it renders a single spinner line that gets overwritten
 * (so the noisy `docker compose pull` output never floods the terminal).
 * In non-interactive mode it only prints milestone messages, one per line.
 */
export interface Reporter {
  /** starts a new phase (spinner message) */
  start(message: string): void;
  /** overwrites the current line with a transient status */
  update(message: string): void;
  /** closes the current phase */
  stop(message: string): void;
  /** prints a persistent message above the spinner */
  message(message: string): void;
}

const MAX_WIDTH = () => Math.max(40, (process.stdout.columns ?? 80) - 12);

function truncate(text: string): string {
  const width = MAX_WIDTH();
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

export function createReporter(interactive: boolean): Reporter {
  if (!interactive) {
    let lastPhase = "";
    return {
      start(message) {
        lastPhase = message;
        console.log(message);
      },
      update() {
        /* transient updates are dropped in non-interactive mode */
      },
      stop(message) {
        if (message && message !== lastPhase) console.log(message);
      },
      message(message) {
        console.log(message);
      },
    };
  }

  const spin = spinner();
  let active = false;
  let phase = "";

  return {
    start(message) {
      phase = message;
      if (active) spin.message(message);
      else {
        spin.start(message);
        active = true;
      }
    },
    update(message) {
      if (!active) return;
      spin.message(`${phase} ${pc.dim(truncate(message))}`);
    },
    stop(message) {
      if (!active) return;
      spin.stop(message || phase);
      active = false;
    },
    message(message) {
      if (active) spin.message(message);
      else console.log(message);
    },
  };
}

// eslint-disable-next-line no-control-regex -- ANSI escape sequences are control chars by design
const ANSI_RE = /\u001b\[[0-9;]*[a-zA-Z]/g;

/** Removes ANSI colour sequences from a terminal line. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * Turns a raw `docker compose` output line into a short human readable status,
 * or `null` when the line carries no useful information.
 */
export function summarizeComposeLine(line: string): string | null {
  const clean = stripAnsi(line).trim();
  if (!clean) return null;
  // progress bars and byte counters are too noisy for a single line
  if (/^\s*$/.test(clean)) return null;
  if (/^[0-9a-f]{12}\s/.test(clean)) {
    // layer lines: "abc123456789 Downloading [===>  ]  12.3MB/98MB"
    const state = clean.match(
      /\b(Pulling fs layer|Waiting|Downloading|Verifying Checksum|Download complete|Extracting|Pull complete|Already exists)\b/,
    );
    return state?.[1] ? `layer ${state[1].toLowerCase()}` : null;
  }
  const service = clean.match(
    /^(?:Container\s+|Image\s+|Service\s+)?(\S+)\s+(Pulling|Pulled|Creating|Created|Starting|Started|Restarting|Restarted|Waiting|Healthy|Running|Recreate|Recreated|Stopping|Stopped)\b/,
  );
  if (service) return `${service[1]} ${service[2]!.toLowerCase()}`;
  if (/^\s*(Network|Volume)\s+\S+\s+(Creating|Created)/.test(clean)) return clean;
  return null;
}

/** True when the compose output indicates an image download is in progress. */
export function isPullLine(line: string): boolean {
  return /\b(Pulling|Downloading|Extracting|Pull complete|Download complete)\b/.test(line);
}
