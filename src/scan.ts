import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { decodeUtf8Strict, listSupportingFiles, scanVault } from "./vault";

export type ScanSeverity = "low" | "medium" | "high";

export interface RuleMatch {
  rule_id: string;
  severity: ScanSeverity;
  message: string;
  line?: number;
}

export type Rule = (content: string) => RuleMatch[];

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

const INJECTION_PHRASES = [
  "ignore previous instructions",
  "ignore all previous instructions",
  "ignore your instructions",
  "disregard all prior instructions",
  "disregard the above",
  "disregard previous instructions",
  "new instructions:",
  "system prompt:",
  "you are now",
];

export const promptInjectionPhraseRule: Rule = (content) => {
  const lower = content.toLowerCase();
  const matches: RuleMatch[] = [];
  for (const phrase of INJECTION_PHRASES) {
    const index = lower.indexOf(phrase);
    if (index !== -1) {
      matches.push({
        rule_id: "prompt-injection-phrase",
        severity: "high",
        message: `contains instruction-override phrase: "${phrase}"`,
        line: lineOf(content, index),
      });
    }
  }
  return matches;
};

const INVISIBLE_CODE_POINTS = new Set([0x200b, 0x200c, 0x200d, 0xfeff]);
const TAG_CHAR_START = 0xe0000;
const TAG_CHAR_END = 0xe007f;

function isInvisibleCodePoint(codePoint: number): boolean {
  return INVISIBLE_CODE_POINTS.has(codePoint) || (codePoint >= TAG_CHAR_START && codePoint <= TAG_CHAR_END);
}

export const invisibleUnicodeRule: Rule = (content) => {
  let count = 0;
  let firstIndex = -1;
  let searchOffset = 0;
  for (const char of content) {
    const codePoint = char.codePointAt(0)!;
    if (isInvisibleCodePoint(codePoint)) {
      count++;
      if (firstIndex === -1) firstIndex = searchOffset;
    }
    searchOffset += char.length;
  }
  if (count === 0) return [];
  return [
    {
      rule_id: "invisible-unicode",
      severity: "high",
      message: `contains ${count} invisible/zero-width Unicode character${count === 1 ? "" : "s"}`,
      line: lineOf(content, firstIndex),
    },
  ];
};

const SECRET_PATTERNS: { pattern: RegExp; describe: string }[] = [
  { pattern: /AKIA[0-9A-Z]{16}/, describe: "AWS-style access key" },
  { pattern: /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/, describe: "PEM private key block" },
  {
    pattern: /\b(api[_-]?key|token|secret)\s*[:=]\s*["']?[A-Za-z0-9_-]{16,}["']?/i,
    describe: "hardcoded credential-shaped assignment",
  },
];

export const secretPatternRule: Rule = (content) => {
  const matches: RuleMatch[] = [];
  for (const { pattern, describe } of SECRET_PATTERNS) {
    const match = pattern.exec(content);
    if (match) {
      matches.push({
        rule_id: "secret-pattern",
        severity: "high",
        message: `contains a ${describe}`,
        line: lineOf(content, match.index),
      });
    }
  }
  return matches;
};

const URL_PATTERN = /https?:\/\/[^\s)"']+/g;
const BARE_IP_URL_PATTERN = /^https?:\/\/(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?/;
const EXFIL_PHRASES = [
  "post this to",
  "send this to",
  "upload this to",
  "send the contents",
  "exfiltrate",
];

export const suspiciousUrlRule: Rule = (content) => {
  const lower = content.toLowerCase();
  const matches: RuleMatch[] = [];
  for (const match of content.matchAll(URL_PATTERN)) {
    const url = match[0]!;
    if (BARE_IP_URL_PATTERN.test(url)) {
      matches.push({
        rule_id: "suspicious-url",
        severity: "medium",
        message: `bare-IP-address URL: ${url}`,
        line: lineOf(content, match.index!),
      });
      continue;
    }
    const nearby = lower.slice(Math.max(0, match.index! - 60), match.index!);
    const exfilPhrase = EXFIL_PHRASES.find((phrase) => nearby.includes(phrase));
    if (exfilPhrase) {
      matches.push({
        rule_id: "suspicious-url",
        severity: "medium",
        message: `URL paired with exfiltration-suggesting text ("${exfilPhrase}"): ${url}`,
        line: lineOf(content, match.index!),
      });
    }
  }
  return matches;
};

export const RULES: Rule[] = [promptInjectionPhraseRule, invisibleUnicodeRule, secretPatternRule, suspiciousUrlRule];

export function scanContent(content: string): RuleMatch[] {
  return RULES.flatMap((rule) => rule(content));
}

export interface ScanFinding extends RuleMatch {
  skill_id: string;
  file: string;
}

export interface ScanResult {
  scanned: number;
  findings: ScanFinding[];
}

interface ScanContentTarget {
  skill_id: string;
  file: string;
  content: string;
}

export async function readTextFileOrNull(path: string): Promise<string | null> {
  try {
    const bytes = await Bun.file(path).bytes();
    return decodeUtf8Strict(bytes);
  } catch {
    return null;
  }
}

async function collectSkillTargets(
  vaultPath: string,
  skillId: string,
  skillMdBody: string,
): Promise<ScanContentTarget[]> {
  const targets: ScanContentTarget[] = [{ skill_id: skillId, file: "SKILL.md", content: skillMdBody }];
  for (const rel of listSupportingFiles(vaultPath, skillId)) {
    const content = await readTextFileOrNull(join(vaultPath, skillId, rel));
    if (content !== null) targets.push({ skill_id: skillId, file: rel, content });
  }
  return targets;
}

interface ResolvedScanTargets {
  targets: ScanContentTarget[];
  /** skill_ids whose SKILL.md could not be parsed/decoded — must still be counted and
   *  flagged, never silently dropped, or a malformed SKILL.md becomes a scan-evasion trick. */
  unparseable: string[];
}

/** Single-skill-dir mode when `rootPath` itself holds a SKILL.md; otherwise treats
 *  `rootPath` as a vault root and enumerates every skill dir under it. */
async function resolveScanTargets(rootPath: string): Promise<ResolvedScanTargets> {
  if (existsSync(join(rootPath, "SKILL.md"))) {
    const skillId = basename(rootPath);
    const vaultPath = dirname(rootPath);
    const body = await readTextFileOrNull(join(rootPath, "SKILL.md"));
    if (body === null) return { targets: [], unparseable: [skillId] };
    return { targets: await collectSkillTargets(vaultPath, skillId, body), unparseable: [] };
  }

  const unparseable: string[] = [];
  const skills = await scanVault(rootPath, (skillId) => unparseable.push(skillId));
  const targets: ScanContentTarget[] = [];
  for (const skill of skills) {
    targets.push(...(await collectSkillTargets(rootPath, skill.skill_id, skill.body)));
  }
  return { targets, unparseable };
}

export async function scanPath(rootPath: string): Promise<ScanResult> {
  const { targets, unparseable } = await resolveScanTargets(rootPath);
  const findings: ScanFinding[] = [];
  const skillIds = new Set<string>();
  for (const target of targets) {
    skillIds.add(target.skill_id);
    for (const match of scanContent(target.content)) {
      findings.push({ ...match, skill_id: target.skill_id, file: target.file });
    }
  }
  for (const skillId of unparseable) {
    skillIds.add(skillId);
    findings.push({
      skill_id: skillId,
      file: "SKILL.md",
      rule_id: "unparseable-skill",
      severity: "medium",
      message: "SKILL.md could not be parsed or decoded — content was not scanned; review manually",
    });
  }
  return { scanned: skillIds.size, findings };
}

export function renderScanText(result: ScanResult): string {
  const skillWord = result.scanned === 1 ? "skill" : "skills";
  if (result.findings.length === 0) {
    return `scanned ${result.scanned} ${skillWord}, no findings`;
  }
  const lines: string[] = [`scanned ${result.scanned} ${skillWord}, ${result.findings.length} finding(s)`];
  for (const finding of result.findings) {
    const location = finding.line !== undefined ? `${finding.file}:${finding.line}` : finding.file;
    lines.push(`[${finding.severity}] ${finding.skill_id}/${location} ${finding.rule_id} — ${finding.message}`);
  }
  return lines.join("\n");
}

export function renderScanJson(result: ScanResult): string {
  return JSON.stringify(result, null, 2);
}

const SEVERITY_RANK: Record<ScanSeverity, number> = { low: 0, medium: 1, high: 2 };

export function scanExitCode(findings: RuleMatch[], failOn: ScanSeverity | undefined): number {
  if (!failOn) return 0;
  const threshold = SEVERITY_RANK[failOn];
  return findings.some((f) => SEVERITY_RANK[f.severity] >= threshold) ? 1 : 0;
}
