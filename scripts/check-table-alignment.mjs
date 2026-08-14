#!/usr/bin/env node
/**
 * A numeric column must be right-aligned in its heading as well as its cells.
 *
 * Why this exists: `.data-table th` sets `text-left`, and it outranks a bare
 * `.num` on specificity, so for months every `<th className="num">` rendered
 * left-aligned over right-aligned figures. On a nine-column variance table the
 * result is that each number appears to sit beneath the *next* heading, and a
 * reader comparing Budget with Actual compares the wrong pair. It was found by
 * looking at a screenshot, not by any of 1,201 unit tests, 7 e2e suites or 4
 * browser journeys - none of which can see where a pixel lands.
 *
 * The CSS is now specific enough. This guards the other half of the problem,
 * which CSS cannot fix: a heading and its cells disagreeing about whether the
 * column is numeric. That is an authoring mistake, one table at a time.
 *
 * The parser is deliberately conservative. JSX tables are built with `.map()`,
 * conditional columns and `colSpan`; anything it cannot line up with certainty
 * it skips rather than guesses at, because a check that cries wolf gets
 * switched off. It therefore under-reports, and that is the intended trade.
 */
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Cell tags, with whether they declare the numeric alignment class. */
function cells(fragment, tag) {
  const found = [];
  const re = new RegExp(`<${tag}\\b([^>]*)>`, 'g');
  let match;
  while ((match = re.exec(fragment)) !== null) {
    const attrs = match[1];
    found.push({
      num: /className=\{?["'`][^"'`]*\bnum\b/.test(attrs),
      dynamic: /className=\{(?!["'`])/.test(attrs) || /colSpan/.test(attrs),
      index: match.index,
    });
  }
  return found;
}

/** Split a fragment into rows, so a cell can be attributed to one. */
function rows(fragment) {
  return fragment
    .split(/<tr\b[^>]*>/)
    .slice(1)
    .map((chunk) => chunk.split('</tr>')[0]);
}

function checkFile(file) {
  const source = readFileSync(path.join(repoRoot, file), 'utf8');
  const problems = [];

  // Each <table>…</table>. Nested tables do not occur here and would be a
  // problem of their own.
  for (const table of source.split('<table').slice(1)) {
    const body = table.split('</table>')[0];

    const head = body.match(/<thead[^>]*>([\s\S]*?)<\/thead>/);
    if (!head) continue;
    const headRows = rows(head[1]);
    if (headRows.length !== 1) continue; // stacked headers: cannot line up columns

    const headings = cells(headRows[0], 'th');
    if (headings.length === 0) continue;
    // A heading generated in a loop stands for an unknown number of columns.
    if (/\.map\(/.test(headRows[0])) continue;

    for (const section of ['tbody', 'tfoot']) {
      const match = body.match(new RegExp(`<${section}[^>]*>([\\s\\S]*?)</${section}>`));
      if (!match) continue;

      for (const row of rows(match[1])) {
        if (/\.map\(/.test(row)) continue;
        const rowCells = [...cells(row, 'td'), ...cells(row, 'th')].sort(
          (a, b) => a.index - b.index,
        );
        if (rowCells.length !== headings.length) continue; // conditional column
        if (rowCells.some((c) => c.dynamic)) continue;

        rowCells.forEach((cell, i) => {
          if (cell.num !== headings[i].num) {
            const heading = headRows[0]
              .split(/<th\b[^>]*>/)
              [i + 1]?.split('</th>')[0]
              .replace(/<[^>]*>/g, '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 40);
            problems.push(
              `${file}: column ${i + 1}${heading ? ` (${heading})` : ''} - ` +
                `heading is ${headings[i].num ? 'numeric' : 'text'} but the cell is ` +
                `${cell.num ? 'numeric' : 'text'}`,
            );
          }
        });
      }
    }
  }
  return problems;
}

const files = globSync('packages/web/src/**/*.tsx', { cwd: repoRoot });
const problems = [...new Set(files.flatMap(checkFile))];

if (problems.length > 0) {
  console.error('Table headings that do not align with their cells:\n');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    '\nAdd or remove className="num" so the heading and its column agree. A right-aligned\n' +
      'figure under a left-aligned heading reads as belonging to the next column.',
  );
  process.exit(1);
}

console.log(`Table alignment: heading and cell alignment agree across ${files.length} components.`);
