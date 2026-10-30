const R = '[redacted]';

const SECRET_KEY = String.raw`[\w.-]*(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|authorization)[\w.-]*`;

/** Order matters: whole tokens first, then `key=value` shapes, so a value is never half replaced. */
const RULES: [RegExp, string][] = [
  // Known token shapes.
  [/\b(?:sk-ant-[\w-]{10,}|sk-[A-Za-z0-9_-]{20,})/g, R],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, R],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, R],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, R],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, R],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, R],
  // `Authorization: Bearer x`, `Bearer x`.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${R}`],
  // Passwords in URLs: scheme://user:password@host.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${R}@`],
  // `"password": "x"` in JSON.
  [new RegExp(String.raw`("${SECRET_KEY}"\s*:\s*)"(?:[^"\\]|\\.)*"`, 'gi'), `$1"${R}"`],
  // `PASSWORD=x`, `--token x`, `--api-key=x`, `password: x`.
  [
    new RegExp(
      String.raw`(\b${SECRET_KEY}\s*[=:]\s*)(?!\[redacted\]|(?:Bearer|Basic|Token)\s)(?:'[^']*'|"[^"]*"|[^\s'",;&|]+)`,
      'gi',
    ),
    `$1${R}`,
  ],
  [new RegExp(String.raw`(--${SECRET_KEY}\s+)(?:'[^']*'|"[^"]*"|[^\s'"-][^\s'"]*)`, 'gi'), `$1${R}`],
  // `mysql -pSecret`.
  [/(\bmysql\b[^|;&]*?\s-p)(?!\s)\S+/g, `$1${R}`],
];

/** Replaces values that look like secrets with `[redacted]`, before a command is stored or shown. */
export function redact(text: string): string {
  return RULES.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text);
}
