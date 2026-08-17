# credentials/ — credential references

English | [中文](README.zh.md)

The credential capability family separates reference resolution from its provider:

| Package | Role | ctx key |
|---|---|---|
| [`credentials/`](credentials/README.md) | Credential-reference seam | `ctx.credentials` |
| [`credentials-local/`](credentials-local/README.md) | Environment and local-file provider | registers `ctx.credentials` |
| [`model-auth/`](model-auth/README.md) | Refreshable model-provider authentication seam | `ctx.modelAuth` |
| [`model-auth-local/`](model-auth-local/README.md) | Private local model-auth provider | registers `ctx.modelAuth` |

Flat credentials carry references, not secret values. Structured model authentication keeps protocol-owned records opaque and exposes only Host request authorization plus browser-safe status. The child READMEs own mutation, precedence, login lifecycle, and storage semantics.

The subsystem reference — `CredentialRef`, per-operation resolution, UI-safe `CredentialInfo`, provider layers — is [docs/subsystems/credentials.md](../../docs/subsystems/credentials.md).
