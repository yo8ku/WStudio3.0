/** Core plugin asset loaders bundled by Vite for the Tauri renderer runtime. */
const entryLoaders = import.meta.glob('../../plugin/core-plugins/*/main.js');
const styleUrls = import.meta.glob('../../plugin/core-plugins/*/styles.css', {
  eager: true,
  import: 'default',
  query: '?url'
});

function corePluginDirectory(pluginId) {
  const prefix = 'com.wstudio.';
  if (!pluginId.startsWith(prefix)) return undefined;
  const directory = pluginId.slice(prefix.length).trim();
  return directory.length > 0 ? directory : undefined;
}

function corePluginAssetKey(pluginId, fileName) {
  const directory = corePluginDirectory(pluginId);
  return directory
    ? `../core-plugins/${directory}/${fileName}`
    : undefined;
}

/** Load a bundled core plugin entry when the native host does not expose a URL. */
export function loadCorePluginModule(pluginId) {
  const key = corePluginAssetKey(pluginId, 'main.js');
  const loader = key ? entryLoaders[key] : undefined;
  return loader ? loader() : Promise.resolve(undefined);
}

/** Resolve the bundled stylesheet URL for a core plugin view. */
export function getCorePluginStylesUrl(pluginId) {
  const key = corePluginAssetKey(pluginId, 'styles.css');
  return key ? styleUrls[key] : undefined;
}
