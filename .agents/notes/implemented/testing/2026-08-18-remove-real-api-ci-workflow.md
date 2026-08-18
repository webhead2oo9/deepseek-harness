# Agent Note: Remove the real-API CI workflow

Status: implemented

English | [中文](2026-08-18-remove-real-api-ci-workflow.zh.md)

## Problem

The real-API GitHub Actions workflow required `DEEPSEEK_API_KEY_EXTERNAL` and failed before running tests in repositories and forks without that secret. API credentials are deployment-specific and cannot be a prerequisite for the repository's automated checks to pass. The provider suites already self-skip when their corresponding key is absent.

## Decision

The repository has no automatic GitHub Actions workflow for `pnpm run test:e2e`. Contributors and operators run the command explicitly when they have the provider keys needed for the suites they want to exercise; each suite retains its own key check and skips independently when the key is absent. Keyless CI and snapshot workflows remain the credential-independent merge signals.

## Alternatives considered

- **Keep the workflow and require a DeepSeek secret** — rejected because a repository without that optional credential would fail before exercising any code.
- **Keep the workflow but permit an all-skipped green run** — rejected because the automatic run would consume build capacity without producing real-provider evidence when no keys were configured.
- **Move real-API tests into the keyless CI workflow** — rejected because live-provider calls remain credentialed, nondeterministic integration evidence rather than a required keyless check.

## Consequences

No API key is required for GitHub Actions to pass, and forks do not need to reproduce repository secrets. CI no longer provides automatic live-provider evidence on trusted pull requests, pushes, or schedules; a reported real-API result must name the explicit keyed run. Reintroducing automatic real-API CI requires a new decision that addresses optional credentials, signal semantics, and the secret-exposure analysis preserved in the [archived workflow note](../../archived/testing/2026-06-19-real-api-e2e-ci.md).
