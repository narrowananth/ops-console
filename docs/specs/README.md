# Specs

One file per change, `<slug>.md`. `/spec <description>` writes it; `/ship <slug>` builds it and sets
its Status to `shipped` in the same PR. The template lives in `.agents/skills/spec/SKILL.md`.
A spec's Status is `draft`, `ready`, `shipped` or `superseded`. A spec a later one replaces in whole is `superseded` and names the replacement; one it replaces in part stays `shipped` and says which parts. A spec built in part keeps `draft` and adds a `**Built:**` line under Status naming what is shipped and what is not.
