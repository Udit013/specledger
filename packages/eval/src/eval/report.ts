import { notImplemented } from './not-implemented.js';
import type { EvaluationReport } from './runner.js';
export const README_START = '<!-- evaluation-results:start -->';
export const README_END = '<!-- evaluation-results:end -->';
export function reportJson(report: EvaluationReport): string {
  return notImplemented('reportJson', report);
}
export function renderMarkdown(report: EvaluationReport): string {
  return notImplemented('renderMarkdown', report);
}
export function renderReadmeSection(report: EvaluationReport): string {
  return notImplemented('renderReadmeSection', report);
}
export function replaceReadmeSection(readme: string, section: string): string {
  return notImplemented('replaceReadmeSection', readme, section);
}
