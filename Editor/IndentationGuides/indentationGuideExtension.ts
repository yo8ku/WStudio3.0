/**
 * Draws indentation guides for the visible CodeMirror lines.
 */

import { RangeSetBuilder, type Extension } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from '@codemirror/view';
import { editorSpaceWidthExtension } from '../Core/editorSpaceWidthExtension';
import {
  buildIndentationGuideLines,
  INDENTATION_COLUMNS,
  type IndentationGuideLine
} from './indentationGuideModel';

const INDENT_MARKER_CLASS = 'cm-indent-markers';
const DOTS_PER_INDENT = 4;

export type IndentationGuideStyle = 'solid' | 'dotted';

interface PositionedGuide {
  readonly column: number;
}

function getVisibleLineNumbers(view: EditorView): number[] {
  const lineNumbers = new Set<number>();

  for (const range of view.visibleRanges) {
    let position = range.from;
    while (position <= range.to) {
      const line = view.state.doc.lineAt(position);
      lineNumbers.add(line.number);
      if (line.to >= range.to) {
        break;
      }
      position = line.to + 1;
    }
  }

  return [...lineNumbers].sort((left, right) => left - right);
}

function createGuideBackground(
  guides: readonly PositionedGuide[],
  activeColumn: number | null,
  style: IndentationGuideStyle
): string {
  if (style === 'dotted') {
    // Dotted guides are four horizontally arranged points in each indent
    // interval. They intentionally do not include a vertical stroke at the
    // interval boundary.
    return guides.flatMap(({ column }) => {
      const color = activeColumn === column
        ? 'var(--indent-marker-active-bg-color)'
        : 'var(--indent-marker-bg-color)';

      return Array.from({ length: DOTS_PER_INDENT }, (_, index) => {
        const dotColumn = column + index + 0.5;
        return `radial-gradient(circle at calc(var(--workbench-editor-space-width) * ${dotColumn}) 50%, ${color} 0 0.9px, transparent 1px) 0 0 / 100% 100% no-repeat`;
      });
    }).join(', ');
  }

  return guides.map(({ column }) => {
    const color = activeColumn === column
      ? 'var(--indent-marker-active-bg-color)'
      : 'var(--indent-marker-bg-color)';
    return `linear-gradient(to right, ${color} 0 100%) calc(var(--workbench-editor-space-width) * ${column}) 0 / 1px 100% no-repeat`;
  }).join(', ');
}

function getPositionedGuides(columns: readonly number[]): PositionedGuide[] {
  return columns.map((column) => ({ column }));
}

function createLineStyle(
  line: IndentationGuideLine,
  guides: readonly PositionedGuide[],
  style: IndentationGuideStyle
): string {
  const maxColumn = Math.max(...guides.map((guide) => guide.column), 0);
  const span = style === 'dotted'
    ? maxColumn + INDENTATION_COLUMNS
    : maxColumn;
  return [
    `--indent-guide-span: calc(var(--workbench-editor-space-width) * ${span}${style === 'solid' ? ' + 1px' : ''})`,
    `--indent-guide-background: ${createGuideBackground(guides, line.activeColumn, style)}`
  ].join('; ');
}

function indentationMarkerTheme(): ReturnType<typeof EditorView.baseTheme> {
  return EditorView.baseTheme({
    '&light': {
      '--indent-marker-bg-color': 'var(--ws-editor-indentGuide-background)',
      '--indent-marker-active-bg-color': 'var(--ws-editor-indentGuide-activeBackground)'
    },
    '&dark': {
      '--indent-marker-bg-color': 'var(--ws-editor-indentGuide-background)',
      '--indent-marker-active-bg-color': 'var(--ws-editor-indentGuide-activeBackground)'
    },
    '.cm-line': {
      position: 'relative',
      isolation: 'isolate'
    },
    '.cm-indent-markers::before': {
      content: '""',
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 0,
      width: 'var(--indent-guide-span)',
      background: 'var(--indent-guide-background)',
      pointerEvents: 'none',
      // Keep the guide behind CodeMirror's text and syntax decorations. A
      // guide may share the same column boundary as a marker, but it must
      // never paint over the glyphs at that boundary.
      zIndex: '-1'
    }
  });
}

function createIndentationMarkers(style: IndentationGuideStyle) {
  return class IndentationMarkers implements PluginValue {
    decorations: DecorationSet = Decoration.none;
    private cursorLine: number;

    constructor(private readonly view: EditorView) {
      this.cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;
      this.generate();
    }

    update(update: ViewUpdate): void {
      const cursorLine = update.state.doc.lineAt(update.state.selection.main.head).number;
      const selectionChanged = cursorLine !== this.cursorLine;
      this.cursorLine = cursorLine;

      if (update.docChanged || update.viewportChanged || update.geometryChanged || selectionChanged) {
        this.generate();
      }
    }

    private generate(): void {
      const builder = new RangeSetBuilder<Decoration>();
      const lineNumbers = getVisibleLineNumbers(this.view);
      const lines = buildIndentationGuideLines(
        this.view.state.doc,
        lineNumbers,
        INDENTATION_COLUMNS,
        this.view.state.tabSize,
        this.cursorLine
      );
      for (const lineNumber of lineNumbers) {
        const line = lines.get(lineNumber);
        if (!line) {
          continue;
        }

        const documentLine = this.view.state.doc.line(lineNumber);
        const guides = getPositionedGuides(line.columns);
        if (guides.length === 0) {
          continue;
        }

        builder.add(
          documentLine.from,
          documentLine.from,
          Decoration.line({
            class: INDENT_MARKER_CLASS,
            attributes: {
              style: createLineStyle(line, guides, style)
            }
          })
        );
      }

      this.decorations = builder.finish();
    }
  };
}

export function createIndentationGuideExtension(
  style: IndentationGuideStyle = 'solid'
): Extension[] {
  return [
    editorSpaceWidthExtension,
    indentationMarkerTheme(),
    ViewPlugin.fromClass(createIndentationMarkers(style), {
      decorations: (plugin) => plugin.decorations
    })
  ];
}

export const indentationGuideExtension = createIndentationGuideExtension('solid');
