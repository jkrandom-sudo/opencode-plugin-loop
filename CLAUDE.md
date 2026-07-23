# CLAUDE.md

## 项目

opencode-plugin-loop — OpenCode 的 `/loop` 命令插件，支持 fixed / adaptive / maintenance 三种调度模式。

- 源码：`src/`（TypeScript，SolidJS TUI 视图）
- 测试：`tests/`（node:test，运行于 `dist/` 构建产物之上）
- 构建 + 测试：`npm test`（先 Babel/tsc 构建到 `dist/`，再跑全部测试）

## 开发流程（必须遵守）

1. **新分支开发**：所有改动从默认分支切 feature 分支（如 `feat/xxx`），不直接在默认分支上提交。
2. **本地验证**：`npm test` 全部通过；涉及 TUI/命令行为的改动需在 OpenCode 中手动端到端验证。
3. **提交 PR 并合并**：验证通过后 `gh pr create`，合并到默认分支。
4. **发布 npm**：
   - 合并后按语义化版本 bump `package.json` 版本号（feat → minor，fix → patch）。
   - npm access token 存放在 `/Users/wangshuai/Downloads/npm_access_token.txt`，使用该文件中最新下发的 token 发布。
   - token 只通过环境变量或发布时临时配置使用（如 `//registry.npmjs.org/:_authToken`），**绝不写入仓库、绝不提交**；本地 `.npmrc` 不得进入 git。
   - 发布：`npm publish`，发布后 `npm view opencode-plugin-loop version` 确认。
