/**
 * 文件说明：声明工作台通用列表选择对话框使用的稳定视图数据。
 */

/** 通用列表选择器中的单个可选项。 */
export interface WorkbenchListPickerItem {
  id: string;
  label: string;
  description?: string;
  depth?: number;
  disabled?: boolean;
}
