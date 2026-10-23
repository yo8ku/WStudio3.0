/** 文件说明：为正文及代码中的多行成对括号提供折叠范围，避免数据数组被画成链接。 */
import { StateField, type Extension, type Range, type Text } from '@codemirror/state';
import { foldService } from '@codemirror/language';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';

interface OpenBracket {
  readonly character: '{' | '[';
  readonly position: number;
  readonly lineFrom: number;
  readonly lineNumber: number;
}

interface BracketFoldRange {
  readonly from: number;
  readonly to: number;
}

interface BracketFoldState {
  readonly folds: ReadonlyMap<number, BracketFoldRange>;
  readonly decorations: DecorationSet;
}

/** 一次扫描缓存各行折叠范围，gutter 查询不重复遍历整篇文档。 */
function buildBracketFoldState(doc: Text): BracketFoldState {
  const stack: OpenBracket[] = [];
  const folds = new Map<number, BracketFoldRange>();
  const marks: Range<Decoration>[] = [];
  let lineFrom = 0;
  let lineNumber = 1;
  let quote: string | null = null;
  let blockComment = false;

  for (const text of doc.iterLines()) {
    // 围栏内部仍扫描代码，但不同围栏之间的括号不可跨块配对。
    if (/^\s*(?:>\s*)*(?:`{3,}|~{3,})/.test(text)) {
      stack.length = 0;
      quote = null;
      blockComment = false;
    } else {
      for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        const nextCharacter = text[index + 1];

        if (blockComment) {
          if (character === '*' && nextCharacter === '/') {
            blockComment = false;
            index += 1;
          }
          continue;
        }
        if (quote) {
          if (character === '\\') index += 1;
          else if (character === quote) quote = null;
          continue;
        }
        if (character === '\\') {
          index += 1;
          continue;
        }
        const apostropheInWord = character === "'" && /[\p{L}\p{N}_]/u.test(text[index - 1] ?? '');
        if (character === '"' || (character === "'" && !apostropheInWord) || character === '`') {
          quote = character;
          continue;
        }
        if (character === '/' && nextCharacter === '/') break;
        if (character === '/' && nextCharacter === '*') {
          blockComment = true;
          index += 1;
          continue;
        }
        if (character === '{' || character === '[') {
          stack.push({ character, position: lineFrom + index, lineFrom, lineNumber });
          continue;
        }
        if (character !== '}' && character !== ']') continue;

        const opening = stack.pop();
        if (!opening || (opening.character === '{' ? '}' : ']') !== character) {
          // 交叉配对属于未完成输入，避免把错误数据折叠到另一层。
          stack.length = 0;
          continue;
        }
        if (opening.lineNumber === lineNumber) continue;

        const closingPosition = lineFrom + index;
        const range = { from: opening.position + 1, to: closingPosition };
        const existing = folds.get(opening.lineFrom);
        if (!existing || range.from < existing.from) folds.set(opening.lineFrom, range);

        const afterClosing = text.slice(index + 1).trimStart()[0];
        if (opening.character === '[' && afterClosing !== '(' && afterClosing !== '[') {
          marks.push(Decoration.mark({ class: 'cm-editor-bracket-data' })
            .range(opening.position, closingPosition + 1));
        }
      }
    }
    lineFrom += text.length + 1;
    lineNumber += 1;
  }

  return { folds, decorations: Decoration.set(marks, true) };
}

/** 配对范围和装饰只随文档变化更新，选择和滚动直接复用缓存。 */
const bracketFoldState = StateField.define<BracketFoldState>({
  create: state => buildBracketFoldState(state.doc),
  update: (value, transaction) => transaction.docChanged
    ? buildBracketFoldState(transaction.newDoc)
    : value,
  provide: field => EditorView.decorations.from(field, value => value.decorations)
});

/** 接入官方折叠服务；没有括号范围的行继续使用标题、代码块等原有折叠。 */
export const editorBracketFoldExtension: Extension = [
  bracketFoldState,
  foldService.of((state, lineStart) => state.field(bracketFoldState).folds.get(lineStart) ?? null),
  EditorView.baseTheme({
    '.cm-content .cm-editor-bracket-data, .cm-content .cm-editor-bracket-data *': {
      textDecoration: 'none'
    }
  })
];
