/** 文件说明：展示普通第三方插件如何通过公开 WebViewerApi 承载网页。 */

const HOME_URL = 'https://www.example.com/';

/** 注册打开网页视图的公开命令。 */
export function activate(context) {
  context.subscriptions.add(
    context.commands.register('com.example.web-viewer.open', () => (
      context.workspace.openView('com.example.web-viewer.view', { instanceId: crypto.randomUUID() })
    ))
  );
}

/** 在插件宿主视图中打开一个网页实例并同步原生承载边界。 */
export async function mountView(context) {
  const updateBounds = () => context.view.setWebViewerBounds({
    x: 0,
    y: 0,
    width: context.view.root.clientWidth,
    height: context.view.root.clientHeight
  });
  context.subscriptions.add(context.view.onDidResize(updateBounds));
  await context.webViewer.open({ url: HOME_URL, title: 'Web Viewer Example' });
  await updateBounds();
}
