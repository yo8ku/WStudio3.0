/** 文件说明：封装系统级渲染端 API，统一访问应用信息与系统字体查询能力。 */
import { nativeApi } from './native';

export const systemApi = {
  getVersion(): Promise<string> {
    return nativeApi.getVersion().then(info => info.version);
  },

  ping(): Promise<string> {
    return nativeApi.ping();
  },

  listFonts(): Promise<string[]> {
    return nativeApi.system.listFonts();
  }
};
