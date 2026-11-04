import { describe, expect, it } from 'vitest';

import { DOCS, SET } from './fixtures.js';
import {
  README_END,
  README_START,
  renderMarkdown,
  renderReadmeSection,
  replaceReadmeSection,
  reportJson,
} from './report.js';
import { runEvaluation } from './runner.js';

const report = runEvaluation({
  documents: DOCS,
  set: SET,
  split: 'dev',
  corpusSha256: 'c'.repeat(64),
  setSha256: 's'.repeat(64),
});

describe('reportJson', () => {
  it('is two-space JSON with a trailing newline that parses back to the report', () => {
    const json = reportJson(report);
    expect(json.endsWith('}\n')).toBe(true);
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(report)));
  });
});

describe('renderMarkdown', () => {
  const md = renderMarkdown(report);

  it('leads with what the numbers are, and states where they come from', () => {
    expect(md.split('\n')[0]).toBe('# Evaluation report');
    expect(md).toContain('Constructed test extractions.');
    for (const fact of ['test-model', 'test-prompt', 'c'.repeat(64), 'dev', '2030-01-01']) {
      expect(md).toContain(fact);
    }
  });

  it('gives the counts behind each rate and the limits of synthetic data', () => {
    expect(md).toContain('2 / 3');
    expect(md).toContain('2 documents evaluated');
    expect(md).toMatch(/synthetic/i);
    expect(md).toContain('p-901-scan');
  });
});

describe('README section', () => {
  const section = renderReadmeSection(report);

  it('replaces only the text between the markers', () => {
    const readme = `# Title\n\nbefore\n${README_START}\nold numbers\n${README_END}\nafter\n`;
    const updated = replaceReadmeSection(readme, section);
    expect(updated).toBe(`# Title\n\nbefore\n${README_START}\n${section}${README_END}\nafter\n`);
    expect(replaceReadmeSection(updated, section)).toBe(updated);
  });

  it('refuses a README without exactly one pair of markers', () => {
    expect(() => replaceReadmeSection('# no markers\n', section)).toThrow(/markers/);
    expect(() =>
      replaceReadmeSection(
        `${README_START}\n${README_END}\n${README_START}\n${README_END}\n`,
        section,
      ),
    ).toThrow(/markers/);
  });

  it('states the origin of the extractions in the section itself', () => {
    expect(section).toContain('Constructed test extractions.');
    expect(section).toContain('precision');
  });
});
