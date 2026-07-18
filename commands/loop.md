---
description: 定时重复执行 prompt。自然语言 Adaptive 请求会立即执行并判断后续调度；显式间隔支持 --jitter=true|false。子命令加 --all 可跨 session。
argument-hint: "[5m] [--jitter=true|false] [prompt text... | list | cancel <id> | pause <id> | resume <id> | stop-all] [--all]"
agent: build
---

$ARGUMENTS
