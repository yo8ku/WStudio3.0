/**
 * Builds four-space indentation guides with Markdown list-scope continuity,
 * excluding quote source indentation from guide rendering.
 */

export interface IndentationGuideDocument {
  readonly lines: number;
  line(lineNumber: number): { readonly text: string };
}

export interface IndentationGuideLine {
  readonly lineNumber: number;
  readonly columns: readonly number[];
  readonly spanColumns: number;
  readonly activeColumn: number | null;
}

export const INDENTATION_COLUMNS = 4;

interface ListItem {
  readonly id: number;
  readonly lineNumber: number;
  readonly indentColumn: number;
  readonly parentId: number | null;
  endLine: number;
}

interface SourceLine {
  readonly lineNumber: number;
  readonly indentColumn: number;
  readonly isBlank: boolean;
  readonly isListItem: boolean;
  readonly isQuote: boolean;
}

const LIST_MARKER_PATTERN = /^(?:\d{1,9}[.)]|[-+*])(?=[ \t]|$)/;

function countColumns(value: string, tabSize: number): number {
  let columns = 0;

  for (const character of value) {
    if (character === ' ' || character === '\u00a0') {
      columns += 1;
    } else if (character === '\t') {
      columns += tabSize - (columns % tabSize);
    } else {
      break;
    }
  }

  return columns;
}

function getSourceLine(
  document: IndentationGuideDocument,
  lineNumber: number,
  tabSize: number
): SourceLine {
  const text = document.line(lineNumber).text;
  const leadingWhitespace = /^[ \t\u00a0]*/.exec(text)?.[0] ?? '';
  const content = text.slice(leadingWhitespace.length);

  return {
    lineNumber,
    indentColumn: countColumns(leadingWhitespace, tabSize),
    isBlank: content.length === 0,
    isListItem: LIST_MARKER_PATTERN.test(content),
    isQuote: content.startsWith('>')
  };
}

function closeItems(
  stack: ListItem[],
  boundaryLine: number,
  minimumIndentColumn: number
): void {
  while (
    stack.length > 0 &&
    stack[stack.length - 1].indentColumn >= minimumIndentColumn
  ) {
    const item = stack.pop();
    if (item) {
      item.endLine = boundaryLine - 1;
    }
  }
}

function collectListItems(
  document: IndentationGuideDocument,
  tabSize: number
): { readonly items: readonly ListItem[]; readonly sourceLines: readonly SourceLine[] } {
  const items: ListItem[] = [];
  const sourceLines: SourceLine[] = [];
  const stack: ListItem[] = [];

  for (let lineNumber = 1; lineNumber <= document.lines; lineNumber += 1) {
    const line = getSourceLine(document, lineNumber, tabSize);
    sourceLines.push(line);

    if (line.isListItem) {
      closeItems(stack, lineNumber, line.indentColumn);
      const parent = stack[stack.length - 1] ?? null;
      const item: ListItem = {
        id: items.length,
        lineNumber,
        indentColumn: line.indentColumn,
        parentId: parent?.id ?? null,
        endLine: document.lines
      };
      items.push(item);
      stack.push(item);
      continue;
    }

    // A top-level non-list block terminates every open list scope. Indented
    // continuation text remains within its current list item; its own
    // four-space guides are calculated separately from the list scope.
    if (!line.isBlank && line.indentColumn === 0) {
      closeItems(stack, lineNumber, 0);
    }
  }

  closeItems(stack, document.lines + 1, 0);
  return { items, sourceLines };
}

function findNearestIndent(
  sourceLines: readonly SourceLine[],
  lineNumber: number,
  direction: -1 | 1
): number | null {
  for (
    let index = lineNumber - 1 + (direction === 1 ? 1 : 0);
    index >= 0 && index < sourceLines.length;
    index += direction
  ) {
    const line = sourceLines[index];
    if (line && !line.isBlank) {
      return line.isQuote ? 0 : line.indentColumn;
    }
  }

  return null;
}

function buildGenericGuideLines(
  sourceLines: readonly SourceLine[],
  lineNumbers: readonly number[],
  indentSize: number,
  cursorLine: number
): Map<number, IndentationGuideLine> {
  const levels = new Map<number, number>();

  for (const line of sourceLines) {
    // Quote indentation can be visually collapsed by Markdown decorations.
    // It must neither draw guides nor extend them through adjacent blank lines.
    if (line.isQuote) {
      levels.set(line.lineNumber, 0);
      continue;
    }

    const indentColumn = line.isBlank
      ? Math.min(
          findNearestIndent(sourceLines, line.lineNumber, -1) ?? 0,
          findNearestIndent(sourceLines, line.lineNumber, 1) ?? 0
        )
      : line.indentColumn;
    levels.set(line.lineNumber, Math.floor(indentColumn / indentSize));
  }

  const result = new Map<number, IndentationGuideLine>();
  const activeLevel = levels.get(cursorLine) ?? 0;
  const activeColumn = activeLevel > 0 ? (activeLevel - 1) * indentSize : null;

  for (const lineNumber of lineNumbers) {
    const level = levels.get(lineNumber) ?? 0;
    if (level === 0) {
      continue;
    }

    const columns = Array.from({ length: level }, (_, index) => index * indentSize);
    result.set(lineNumber, {
      lineNumber,
      columns,
      spanColumns: columns[columns.length - 1] + 1,
      activeColumn: columns.includes(activeColumn ?? -1) ? activeColumn : null
    });
  }

  return result;
}

function getWhitespaceGuideColumns(
  line: SourceLine,
  indentSize: number
): number[] {
  const level = Math.floor(line.indentColumn / indentSize);
  return Array.from({ length: level }, (_, index) => index * indentSize);
}

function findNearestContentLine(
  sourceLines: readonly SourceLine[],
  lineNumber: number,
  direction: -1 | 1
): SourceLine | null {
  for (
    let index = lineNumber - 1 + (direction === 1 ? 1 : 0);
    index >= 0 && index < sourceLines.length;
    index += direction
  ) {
    const line = sourceLines[index];
    if (line && !line.isBlank) {
      return line;
    }
  }

  return null;
}

function intersectColumns(left: readonly number[], right: readonly number[]): number[] {
  const rightColumns = new Set(right);
  return left.filter((column) => rightColumns.has(column));
}

function mergeColumns(...columnGroups: readonly (readonly number[])[]): number[] {
  return [...new Set(columnGroups.flat())].sort((left, right) => left - right);
}

function findOwningListItem(
  items: readonly ListItem[],
  lineNumber: number
): ListItem | null {
  // The most recent open list item owns continuation text. Its own whitespace
  // never creates another level; only list markers can do that.
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (
      item &&
      item.lineNumber <= lineNumber &&
      lineNumber <= item.endLine
    ) {
      return item;
    }
  }

  return null;
}

function getAncestorColumns(
  itemsById: ReadonlyMap<number, ListItem>,
  item: ListItem | null,
  indentSize: number
): number[] {
  const ancestors: ListItem[] = [];
  let parentId = item?.parentId ?? null;

  while (parentId !== null) {
    const parent = itemsById.get(parentId);
    if (!parent) {
      break;
    }

    ancestors.push(parent);
    parentId = parent.parentId;
  }

  // Guide positions are based on nesting depth, not the source line's
  // incidental marker spacing. This keeps every level exactly one indent
  // unit apart, even when Markdown uses three spaces before a nested marker.
  return ancestors
    .reverse()
    .map((_, index) => index * indentSize);
}

function columnsBeforeText(
  columns: readonly number[],
  line: SourceLine
): number[] {
  // A guide at the first text column paints through the first glyph. Only
  // columns strictly inside the line's leading whitespace are drawable.
  return columns.filter((column) => column < line.indentColumn);
}

export function buildIndentationGuideLines(
  document: IndentationGuideDocument,
  lineNumbers: readonly number[],
  indentSize: number,
  tabSize: number,
  cursorLine: number
): Map<number, IndentationGuideLine> {
  const normalizedTabSize = Math.max(1, tabSize);
  const normalizedIndentSize = Math.max(1, indentSize);
  const { items, sourceLines } = collectListItems(document, normalizedTabSize);
  if (items.length === 0) {
    return buildGenericGuideLines(sourceLines, lineNumbers, normalizedIndentSize, cursorLine);
  }

  const sourceLineByNumber = new Map(sourceLines.map((line) => [line.lineNumber, line]));
  const itemsById = new Map(items.map((item) => [item.id, item]));

  const getListGuideColumns = (line: SourceLine): number[] => {
    const owner = findOwningListItem(items, line.lineNumber);
    if (!owner) {
      return [];
    }

    const ancestorColumns = columnsBeforeText(
      getAncestorColumns(itemsById, owner, normalizedIndentSize),
      line
    );

    if (line.isListItem) {
      return ancestorColumns;
    }

    if (ancestorColumns.length > 0) {
      return ancestorColumns;
    }

    // A top-level list item may have continuation text indented by fewer
    // than four spaces. Keep its parent scope continuous, while the regular
    // four-space rule adds any deeper guides separately.
    return line.indentColumn > owner.indentColumn
      ? [0]
      : [];
  };

  const getContentGuideColumns = (line: SourceLine): number[] => line.isQuote ? [] : mergeColumns(
    getWhitespaceGuideColumns(line, normalizedIndentSize),
    getListGuideColumns(line)
  );

  const activeLineColumns = getContentGuideColumns(
    sourceLineByNumber.get(cursorLine) ?? {
      lineNumber: cursorLine,
      indentColumn: 0,
      isBlank: true,
      isListItem: false,
      isQuote: false
    }
  );
  const result = new Map<number, IndentationGuideLine>();
  const activeColumn = activeLineColumns[activeLineColumns.length - 1] ?? null;

  for (const lineNumber of lineNumbers) {
    const sourceLine = sourceLineByNumber.get(lineNumber);
    if (!sourceLine) {
      continue;
    }

    let columns: number[];
    if (!sourceLine.isBlank) {
      columns = getContentGuideColumns(sourceLine);
    } else {
      // Blank lines preserve only the guide columns shared by the nearest
      // content above and below. This keeps outer guides continuous while
      // dropping inner guides when a nested block ends.
      const above = findNearestContentLine(sourceLines, lineNumber, -1);
      const below = findNearestContentLine(sourceLines, lineNumber, 1);
      const aboveColumns = above ? getContentGuideColumns(above) : [];
      const belowColumns = below ? getContentGuideColumns(below) : [];
      columns = intersectColumns(aboveColumns, belowColumns);

      // When a nested list is followed by a new top-level item, carry only
      // the outermost guide through the separator blank. This avoids a visual
      // break without leaking the finished nested scopes into the sibling.
      if (
        columns.length === 0 &&
        aboveColumns.length > 0 &&
        below?.isListItem &&
        below.indentColumn === 0
      ) {
        columns = [aboveColumns[0]];
      }
    }

    if (columns.length === 0) {
      continue;
    }

    result.set(lineNumber, {
      lineNumber,
      columns,
      spanColumns: columns[columns.length - 1] + 1,
      activeColumn: activeColumn !== null && columns.includes(activeColumn)
        ? activeColumn
        : null
    });
  }

  return result;
}
