/** 文件说明：提供使用根入口文件的最小第三方插件示例。 */

/** 激活示例插件并注册一个命令。 */
export function activate(context) {
  context.subscriptions.add(
    context.commands.register('com.example.word-count.show', async () => {
      context.logger.info('Word Count command executed.');
    })
  );
}

/** 示例插件不持有 subscriptions 之外的外部资源。 */
export function deactivate() {
  // The host disposes context.subscriptions after this hook completes.
}
