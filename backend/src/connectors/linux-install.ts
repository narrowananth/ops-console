/** How a command the Connectors need is installed on Linux; the console prints these and runs none of them. */
type Package = { apt?: string; dnf?: string; pacman?: string; brew?: string; elsewhere?: string };

const PACKAGES: Record<string, Package> = {
  gh: { apt: 'gh', dnf: 'gh', pacman: 'github-cli', brew: 'gh' },
  glab: { apt: 'glab', dnf: 'glab', pacman: 'glab', brew: 'glab' },
  aws: { apt: 'awscli', dnf: 'awscli2', pacman: 'aws-cli', brew: 'awscli' },
  uvx: { pacman: 'uv', brew: 'uv', elsewhere: 'pipx install uv' },
  'github-mcp-server': {
    brew: 'github-mcp-server',
    elsewhere: 'download it from github.com/github/github-mcp-server/releases',
  },
};

const MANAGERS = [
  ['Debian or Ubuntu', 'sudo apt install', 'apt'],
  ['Fedora', 'sudo dnf install', 'dnf'],
  ['Arch', 'sudo pacman -S', 'pacman'],
] as const;

/**
 * What to tell the operator when a command is missing on Linux: the install command for each package manager that
 * carries it, Homebrew's when `brew` is installed, and the command's own way where no distro packages it. The package
 * names are the distros' usual ones; the spike confirms them.
 */
export function linuxInstallAdvice(missing: string[], brew: boolean): string {
  const names = missing.join(', ');
  const lines: string[] = [];
  for (const [label, command, key] of MANAGERS) {
    const packages = missing.flatMap((name) => PACKAGES[name]?.[key] ?? []);
    if (packages.length > 0) lines.push(`${label}: \`${command} ${packages.join(' ')}\``);
  }
  const other = missing.flatMap((name) => {
    const how = PACKAGES[name]?.elsewhere;
    return how ? [`${name}: ${how}`] : [];
  });
  if (brew) {
    const formulas = missing.flatMap((name) => PACKAGES[name]?.brew ?? name);
    lines.push(`Homebrew: \`brew install ${formulas.join(' ')}\``);
  }
  const how = [...lines, ...other].join('; ');
  const verb = missing.length === 1 ? 'is' : 'are';
  return `${names} ${verb} not installed. Install ${missing.length === 1 ? 'it' : 'them'}${how ? ` (${how})` : ' with your package manager'}, then Connect again`;
}
