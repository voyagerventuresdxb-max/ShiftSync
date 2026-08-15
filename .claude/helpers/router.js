#!/usr/bin/env node
/**
 * Ruflo Agent Router
 *
 * Static keyword router that suggests an agent for a task description.
 * NOTE: This is *not* a learned model. It is a heuristic table; "confidence"
 * is reported as a heuristic prior, not a calibrated probability.
 *
 * #2257 fix: patterns are now word-boundary-anchored so short tokens like
 * `cd`, `ci`, `ui`, `add`, `structure` no longer match inside unrelated
 * words (`decision`, `infrastructure`, `address`, `addendum`). Default
 * matched-confidence dropped from 0.8 to 0.6, and fall-through from 0.5 to
 * 0.3, to reflect that this is a static heuristic, not a learned classifier.
 */

const AGENT_CAPABILITIES = {
  coder: ['code-generation', 'refactoring', 'debugging', 'implementation'],
  tester: ['unit-testing', 'integration-testing', 'coverage', 'test-generation'],
  reviewer: ['code-review', 'security-audit', 'quality-check', 'best-practices'],
  researcher: ['web-search', 'documentation', 'analysis', 'summarization'],
  architect: ['system-design', 'architecture', 'patterns', 'scalability'],
  'backend-dev': ['api', 'database', 'server', 'authentication'],
  'frontend-dev': ['ui', 'react', 'css', 'components'],
  devops: ['ci-cd', 'docker', 'deployment', 'infrastructure'],
};

// Each entry has a token list. Single tokens get \b…\b boundaries so 'cd'
// won't match inside 'decide'. Phrases (whitespace or '/') match literally —
// the whitespace acts as a natural boundary.
const TASK_PATTERNS = [
  { tokens: ['implement', 'create', 'build', 'add', 'write code', 'refactor', 'debug'], agent: 'coder' },
  { tokens: ['test', 'tests', 'spec', 'coverage', 'unit test', 'integration test'], agent: 'tester' },
  { tokens: ['review', 'audit', 'check', 'validate', 'security'], agent: 'reviewer' },
  { tokens: ['research', 'find', 'search', 'documentation', 'explore'], agent: 'researcher' },
  { tokens: ['design', 'architect', 'architecture', 'structure', 'plan'], agent: 'architect' },
  { tokens: ['api', 'endpoint', 'server', 'backend', 'database'], agent: 'backend-dev' },
  { tokens: ['ui', 'frontend', 'component', 'react', 'css', 'style'], agent: 'frontend-dev' },
  { tokens: ['deploy', 'docker', 'ci', 'cd', 'ci/cd', 'pipeline', 'infrastructure', 'devops'], agent: 'devops' },
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildPattern(tokens) {
  const alternatives = tokens.map((tok) => {
    const escaped = escapeRegex(tok.toLowerCase());
    if (/\s|\//.test(tok)) return escaped;
    return `\\b${escaped}\\b`;
  });
  return new RegExp(`(?:${alternatives.join('|')})`, 'i');
}

const COMPILED_PATTERNS = TASK_PATTERNS.map((entry) => ({
  agent: entry.agent,
  tokens: entry.tokens,
  regex: buildPattern(entry.tokens),
}));

function routeTask(task) {
  const taskLower = String(task == null ? '' : task).toLowerCase();
  for (const entry of COMPILED_PATTERNS) {
    if (entry.regex.test(taskLower)) {
      return {
        agent: entry.agent,
        confidence: 0.6,
        reason: `Matched keyword(s) from: ${entry.tokens.join('|')}`,
      };
    }
  }
  return {
    agent: 'coder',
    confidence: 0.3,
    reason: 'Default routing - no specific keyword matched',
  };
}

// CLI
const task = process.argv.slice(2).join(' ');

if (task) {
  const result = routeTask(task);
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('Usage: router.js <task description>');
  console.log('\nAvailable agents:', Object.keys(AGENT_CAPABILITIES).join(', '));
}

module.exports = { routeTask, AGENT_CAPABILITIES, TASK_PATTERNS, buildPattern };
