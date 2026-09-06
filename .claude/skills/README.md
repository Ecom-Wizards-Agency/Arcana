# Repository coding skills

These skills provide TypeScript guidance for agents reading or editing this source
tree. Repository authority, file scope and public hygiene remain governed by
[AGENTS.md](../../AGENTS.md).

The two skills are vendored from
[pstack](https://github.com/cursor/plugins/tree/main/pstack) v0.14.2 by Lauren Tan
("poteto"), MIT licensed, vendored 24.08.2026. Preserve their upstream attribution
when updating them.

| Local skill | Upstream | Local adjustment |
| --- | --- | --- |
| [typescript-best-practices](typescript-best-practices/SKILL.md) | [Upstream skill](https://github.com/cursor/plugins/tree/main/pstack/skills/typescript-best-practices) | Removed `disable-model-invocation: true`; otherwise unchanged. |
| [principle-type-system-discipline](principle-type-system-discipline/SKILL.md) | [Upstream skill](https://github.com/cursor/plugins/tree/main/pstack/skills/principle-type-system-discipline) | Removed `disable-model-invocation: true`; otherwise unchanged. |

Automatic invocation is intentional for `.ts` and `.tsx` work. Keep referenced skill
resources beside the vendored files so a public checkout is sufficient to read them.
