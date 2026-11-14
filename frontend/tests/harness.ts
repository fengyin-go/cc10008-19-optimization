/**
 * 极简断言工具：不引入第三方依赖，配合 Vite 的 SSR 加载器直接跑 TS。
 */
let passed = 0
const failures: { name: string; error: unknown }[] = []
const suiteStack: string[] = []

export function describe(name: string, body: () => void): void {
  suiteStack.push(name)
  try {
    body()
  } finally {
    suiteStack.pop()
  }
}

export function it(name: string, body: () => void | Promise<void>): void {
  const fullName = [...suiteStack, name].join(' / ')
  try {
    const result = body()
    if (result instanceof Promise) {
      result.then(
        () => {
          passed += 1
        },
        (error) => {
          failures.push({ name: fullName, error })
        },
      )
      pendingPromises.push(result)
    } else {
      passed += 1
    }
  } catch (error) {
    failures.push({ name: fullName, error })
  }
}

const pendingPromises: Promise<unknown>[] = []

export async function finish(): Promise<void> {
  while (pendingPromises.length > 0) {
    const current = pendingPromises.splice(0)
    await Promise.allSettled(current)
  }
  for (const failure of failures) {
    console.error(`✗ ${failure.name}`)
    console.error(failure.error)
  }
  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
  if (failures.length > 0) {
    process.exitCode = 1
  }
}

export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`断言失败：${message}`)
  }
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(expected)
  if (actualJson !== expectedJson) {
    throw new Error(`${message}\n  期望: ${expectedJson}\n  实际: ${actualJson}`)
  }
}

export function assertDeepEqual<T>(actual: T, expected: T, message: string): void {
  assertEqual(actual, expected, message)
}

export async function assertRejects(
  body: () => Promise<unknown>,
  errorName: string,
  message: string,
): Promise<void> {
  let thrown: unknown = null
  try {
    await body()
  } catch (error) {
    thrown = error
  }
  assert(thrown !== null, `${message}（预期抛出 ${errorName}，但未抛出）`)
  assert(
    (thrown as { name?: string }).name === errorName,
    `${message}（预期 ${errorName}，实际 ${(thrown as Error).name}：${(thrown as Error).message}）`,
  )
}
