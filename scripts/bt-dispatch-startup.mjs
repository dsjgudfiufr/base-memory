#!/usr/bin/env node
/**
 * bt-dispatch-startup.mjs — 网关启动时自动恢复调度
 *
 * 用法:
 *   node bt-dispatch-startup.mjs          # 手动运行
 *   OpenClaw hooks: gateway:startup 事件触发
 */

import { dispatchOnce } from './bt-dispatch.mjs';

console.log('🚀 启动调度检查...');
await dispatchOnce();
