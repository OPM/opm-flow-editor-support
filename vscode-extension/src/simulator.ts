// ---------------------------------------------------------------------------
// Pure helpers for launching the OPM Flow simulator on a deck.
//
// The extension can optionally verify (dry-run load check) or run a deck with a
// locally installed `flow` binary. On Windows the binary commonly lives inside
// WSL, so these helpers build a POSIX shell command and, when WSL is enabled,
// translate the Windows deck path to its `/mnt/<drive>` mount point and target
// the chosen distribution.
//
// Kept free of vscode imports so they can be unit-tested under jest. The thin
// vscode glue (reading settings, opening a terminal) lives in extension.ts.
// ---------------------------------------------------------------------------

import * as path from 'path';

/** Resolved `opm-flow.simulator.*` settings. */
export interface SimulatorConfig {
  /** Path to the flow executable. In WSL mode this is a Linux path. */
  executablePath: string;
  /** Run via `wsl.exe` (Windows + WSL). */
  useWsl: boolean;
  /** WSL distribution name; empty string means the default distribution. */
  wslDistribution: string;
  /** Extra arguments for "Run Simulation". */
  runArgs: string[];
  /** Arguments for "Verify Deck"; the default makes flow load but not solve. */
  verifyArgs: string[];
}

export type SimulatorMode = 'run' | 'verify';

/**
 * A launchable command: the POSIX shell line to send to the terminal, plus the
 * shell the terminal must use. In WSL mode the terminal is a `wsl.exe` bash
 * session so the command runs inside the distribution; otherwise the default
 * integrated-terminal shell is used (assumed POSIX on Linux/macOS).
 */
export interface DeckCommand {
  commandLine: string;
  shellPath?: string;
  shellArgs?: string[];
  /** Stable signature of the shell, so a cached terminal can be reused. */
  shellSignature: string;
}

/**
 * Convert a Windows path (`C:\a\b`) to its WSL mount path (`/mnt/c/a/b`).
 * Paths that are already POSIX-style pass through with backslashes (if any)
 * normalised to forward slashes.
 */
export function windowsPathToWsl(p: string): string {
  // A deck opened from inside the WSL filesystem via the UNC share
  // (\\wsl$\<distro>\home\... or \\wsl.localhost\<distro>\home\...) is already
  // a Linux path — strip the share + distro prefix back to the absolute path.
  const unc = /^\\\\wsl(?:\$|\.localhost)\\[^\\]+(\\.*)?$/.exec(p);
  if (unc) {
    const rest = (unc[1] ?? '').replace(/\\/g, '/');
    return rest === '' ? '/' : rest;
  }
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (m) {
    const drive = m[1].toLowerCase();
    const rest = m[2].replace(/\\/g, '/');
    return `/mnt/${drive}/${rest}`;
  }
  return p.replace(/\\/g, '/');
}

/** Single-quote a token for POSIX `sh`, escaping any embedded single quotes. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the shell command (and required shell) that runs `flow` on a deck.
 *
 * The command `cd`s into the deck's own directory first so the deck's relative
 * `INCLUDE` / `PATHS` references resolve, then invokes the executable on the
 * bare deck filename with the mode's arguments.
 */
export function buildDeckCommand(
  deckFsPath: string,
  mode: SimulatorMode,
  cfg: SimulatorConfig,
): DeckCommand {
  const args = mode === 'verify' ? cfg.verifyArgs : cfg.runArgs;

  if (cfg.useWsl) {
    // The deck path is a Windows path (the WSL scenario is Windows-only), so
    // split it with win32 semantics regardless of the host running this code —
    // otherwise a POSIX host (e.g. CI) would mishandle the backslashes.
    const wslDir = windowsPathToWsl(path.win32.dirname(deckFsPath));
    const deckName = path.win32.basename(deckFsPath);
    const line = [
      'cd', shQuote(wslDir), '&&',
      shQuote(cfg.executablePath), shQuote(deckName),
      ...args.map(shQuote),
    ].join(' ');
    const shellArgs = cfg.wslDistribution ? ['-d', cfg.wslDistribution] : [];
    return {
      commandLine: line,
      shellPath: 'wsl.exe',
      shellArgs,
      shellSignature: `wsl:${cfg.wslDistribution}`,
    };
  }

  // Native (Linux/macOS): the deck path is POSIX and the integrated terminal's
  // default shell is POSIX, so split with posix semantics for determinism.
  const dir = path.posix.dirname(deckFsPath);
  const deckName = path.posix.basename(deckFsPath);
  const line = [
    'cd', shQuote(dir), '&&',
    shQuote(cfg.executablePath), shQuote(deckName),
    ...args.map(shQuote),
  ].join(' ');
  return { commandLine: line, shellSignature: 'default' };
}
