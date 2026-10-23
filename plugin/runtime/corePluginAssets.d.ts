import type { PluginEntryModule } from '../sdk/types';

type PluginModule = Partial<PluginEntryModule>;

export declare function loadCorePluginModule(pluginId: string): Promise<PluginModule | undefined>;
export declare function getCorePluginStylesUrl(pluginId: string): string | undefined;
