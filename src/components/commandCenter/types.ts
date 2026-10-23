/**
 * 文件说明：定义命令中心展示所需的基础数据结构。
 */
export interface CommandCenterItem {
  id: string;
  title: string;
  description: string;
  group: string;
  shortcut?: string;
  action?:
    | { type: 'plugin-command'; pluginId: string; commandId: string }
    | { type: 'plugin-view'; pluginId: string; viewType: string };
}
