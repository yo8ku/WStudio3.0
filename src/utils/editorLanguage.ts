/**
 * 文件说明：定义工作台编辑器唯一允许使用的语言配置。
 */
export interface WorkbenchEditorLanguage {
  id: string;
  label: string;
}

export const WORKBENCH_EDITOR_LANGUAGE: WorkbenchEditorLanguage = {
  id: 'markdown',
  label: 'Markdown'
};
