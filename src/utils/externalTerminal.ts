import { spawn } from 'child_process';

interface TerminalCommand {
  command: string;
  args: string[];
}

export async function openExternalTerminal(scriptPath: string): Promise<void> {
  if (process.platform === 'win32') {
    await spawnDetached('cmd.exe', [
      '/d',
      '/c',
      scriptPath
    ]);
    return;
  }

  if (process.platform === 'darwin') {
    await spawnDetached('open', ['-a', 'Terminal', scriptPath]);
    return;
  }

  await openLinuxExternalTerminal(scriptPath);
}

async function openLinuxExternalTerminal(scriptPath: string): Promise<void> {
  const candidates: TerminalCommand[] = [
    { command: 'x-terminal-emulator', args: ['-e', 'bash', scriptPath] },
    { command: 'gnome-terminal', args: ['--', 'bash', scriptPath] },
    { command: 'konsole', args: ['-e', 'bash', scriptPath] },
    { command: 'xfce4-terminal', args: ['-e', `bash ${quoteShellPart(scriptPath)}`] },
    { command: 'xterm', args: ['-e', 'bash', scriptPath] }
  ];

  for (const candidate of candidates) {
    try {
      await spawnDetached(candidate.command, candidate.args);
      return;
    } catch {
      continue;
    }
  }

  throw new Error('Could not open an external terminal window on this Linux system');
}

function spawnDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });

    child.on('error', reject);
    child.on('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function quoteShellPart(part: string): string {
  if (/^[A-Za-z0-9._:/\\-]+$/.test(part)) {
    return part;
  }

  return `"${part.replace(/"/g, '\\"')}"`;
}
