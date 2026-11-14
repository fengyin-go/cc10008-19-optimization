import { QueryEngine } from '@/query-engine'

/**
 * 工作台共享同一个引擎实例：两个标签页（会话）在同一引擎内通过 sessionId 隔离批次。
 * 模块级单例保证切换路由再回来时缓存与批次状态不丢。
 */
export const queryEngine = new QueryEngine()
