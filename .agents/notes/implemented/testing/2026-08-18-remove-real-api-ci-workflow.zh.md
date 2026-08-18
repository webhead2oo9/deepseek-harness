# Agent Note: 移除真实 API CI 工作流

Status: implemented

[English](2026-08-18-remove-real-api-ci-workflow.md) | 中文

## 问题

真实 API GitHub Actions 工作流要求 `DEEPSEEK_API_KEY_EXTERNAL`，并会在未配置该 secret 的仓库和 fork 中于运行测试前失败。API 凭据属于部署配置，不能成为仓库自动检查通过的前提。各提供方套件已经会在缺少对应密钥时自动跳过。

## 决策

仓库不再包含自动运行 `pnpm run test:e2e` 的 GitHub Actions 工作流。贡献者和运维人员在拥有目标套件所需的提供方密钥时显式运行该命令；每个套件保留自身的密钥检查，缺少密钥时独立跳过。keyless CI 与快照工作流继续作为不依赖凭据的合并信号。

## 曾考虑的替代方案

- **保留工作流并要求 DeepSeek secret**：否决，因为没有该可选凭据的仓库会在执行任何代码前失败。
- **保留工作流但允许全部跳过的绿色运行**：否决，因为未配置密钥时，自动运行只会消耗构建容量，却不产生真实提供方证据。
- **把真实 API 测试移入 keyless CI 工作流**：否决，因为线上提供方调用仍是需要凭据且具有不确定性的集成证据，而非必需的 keyless 检查。

## 后果

GitHub Actions 无需任何 API 密钥即可通过，fork 也无需复制仓库 secret。CI 不再为可信 PR、push 或 schedule 自动提供线上提供方证据；报告真实 API 结果时必须指明显式的带密钥运行。重新引入自动真实 API CI 时，必须通过新决策处理可选凭据、信号语义以及[已归档工作流 Agent Note](../../archived/testing/2026-06-19-real-api-e2e-ci.md)中保留的 secret 暴露分析。
