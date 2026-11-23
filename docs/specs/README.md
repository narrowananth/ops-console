# Specs

One file per change, `<slug>.md`. `/spec <description>` writes it; `/ship <slug>` builds it and sets
its Status to `shipped` in the same PR. The template lives in `.agents/skills/spec/SKILL.md`.
A spec's Status is `draft`, `ready` or `shipped`; a spec a later one replaces in part says which parts.
