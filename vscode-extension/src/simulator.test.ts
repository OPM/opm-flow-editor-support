import {
  windowsPathToWsl,
  shQuote,
  buildDeckCommand,
  SimulatorConfig,
} from './simulator';

describe('windowsPathToWsl', () => {
  it('maps a drive-letter path to /mnt/<drive>', () => {
    expect(windowsPathToWsl('C:\\gitroot\\decks\\spe1')).toBe('/mnt/c/gitroot/decks/spe1');
  });

  it('lower-cases the drive letter', () => {
    expect(windowsPathToWsl('D:\\Foo\\Bar')).toBe('/mnt/d/Foo/Bar');
  });

  it('accepts forward-slash drive paths', () => {
    expect(windowsPathToWsl('C:/a/b')).toBe('/mnt/c/a/b');
  });

  it('passes POSIX paths through, normalising backslashes', () => {
    expect(windowsPathToWsl('/home/u/decks')).toBe('/home/u/decks');
    expect(windowsPathToWsl('rel\\path')).toBe('rel/path');
  });

  it('unwraps a \\\\wsl$ UNC share back to the Linux path', () => {
    expect(windowsPathToWsl('\\\\wsl$\\ubuntu-26.04\\home\\u\\decks')).toBe('/home/u/decks');
  });

  it('unwraps a \\\\wsl.localhost UNC share', () => {
    expect(windowsPathToWsl('\\\\wsl.localhost\\Ubuntu\\tmp\\case')).toBe('/tmp/case');
  });
});

describe('shQuote', () => {
  it('wraps a plain token in single quotes', () => {
    expect(shQuote('flow')).toBe("'flow'");
  });

  it('handles paths with spaces', () => {
    expect(shQuote('/mnt/c/my decks/spe1')).toBe("'/mnt/c/my decks/spe1'");
  });

  it('escapes embedded single quotes', () => {
    expect(shQuote("a'b")).toBe("'a'\\''b'");
  });
});

describe('buildDeckCommand', () => {
  const wslCfg: SimulatorConfig = {
    executablePath: '/usr/bin/flow',
    useWsl: true,
    wslDistribution: 'ubuntu-26.04',
    runArgs: [],
    verifyArgs: ['--enable-dry-run=true'],
  };

  it('builds a WSL verify command with mount-translated path and distro', () => {
    const cmd = buildDeckCommand('C:\\gitroot\\decks\\SPE1.DATA', 'verify', wslCfg);
    expect(cmd.shellPath).toBe('wsl.exe');
    expect(cmd.shellArgs).toEqual(['-d', 'ubuntu-26.04']);
    expect(cmd.shellSignature).toBe('wsl:ubuntu-26.04');
    expect(cmd.commandLine).toBe(
      "cd '/mnt/c/gitroot/decks' && '/usr/bin/flow' 'SPE1.DATA' '--enable-dry-run=true'",
    );
  });

  it('uses runArgs (not verifyArgs) in run mode', () => {
    const cfg: SimulatorConfig = { ...wslCfg, runArgs: ['--threads-per-process=4'] };
    const cmd = buildDeckCommand('C:\\d\\CASE.DATA', 'run', cfg);
    expect(cmd.commandLine).toBe(
      "cd '/mnt/c/d' && '/usr/bin/flow' 'CASE.DATA' '--threads-per-process=4'",
    );
  });

  it('omits the -d flag when no distribution is set', () => {
    const cfg: SimulatorConfig = { ...wslCfg, wslDistribution: '' };
    const cmd = buildDeckCommand('C:\\d\\CASE.DATA', 'verify', cfg);
    expect(cmd.shellArgs).toEqual([]);
    expect(cmd.shellSignature).toBe('wsl:');
  });

  it('builds a native command with the default shell', () => {
    const cfg: SimulatorConfig = {
      executablePath: 'flow',
      useWsl: false,
      wslDistribution: '',
      runArgs: [],
      verifyArgs: ['--enable-dry-run=true'],
    };
    const cmd = buildDeckCommand('/home/u/decks/CASE.DATA', 'run', cfg);
    expect(cmd.shellPath).toBeUndefined();
    expect(cmd.shellSignature).toBe('default');
    expect(cmd.commandLine).toBe("cd '/home/u/decks' && 'flow' 'CASE.DATA'");
  });
});
