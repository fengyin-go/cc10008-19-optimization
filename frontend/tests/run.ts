import { createServer } from 'vite'

/**
 * 通过 Vite 的 SSR 加载器运行 TS 测试：
 * 复用 vite.config.ts 的路径别名与 TS 转译，无需安装额外测试框架。
 * 注意 run.ts 自身也通过 ssrLoadModule 取 harness，保证与 spec 共享同一份计数器。
 */
const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
})

try {
  const harness = await vite.ssrLoadModule('/tests/harness.ts')
  const module = await vite.ssrLoadModule('/tests/engine.spec.ts')
  await module.run()
  await harness.finish()
} finally {
  await vite.close()
}
