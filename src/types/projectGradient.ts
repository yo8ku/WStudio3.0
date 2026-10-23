/**
 * 文件说明：定义标题栏项目颜色控件向工作台父级发布的渐变展示契约。
 */

export type ProjectColorId =
  | 'amber'
  | 'olive'
  | 'grass-green'
  | 'sea-blue'
  | 'sky-blue'
  | 'cobalt-blue'
  | 'purple'
  | 'magenta'
  | 'custom';

export type ProjectGradientStyle = Readonly<Record<'--ws-project-color', string>>;

export interface ProjectGradientPresentation {
  enabled: boolean;
  colorClass: string;
  style: ProjectGradientStyle | undefined;
}
