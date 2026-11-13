# ADR 0004 — Kebab House : une vitrine open source, centrée sur les skills

- **Status:** Accepted
- **Date:** 2026-11-13
- **Deciders:** Yassine (Founder)
- **Scope:** positionnement, nom, feuille de route — voir `docs/specs/kebab-house-phase-0.md` à `kebab-house-phase-3.md`

## Context

Kebab MCP s'est construit comme « un endpoint, 97+ outils ». En novembre 2026 :

- la couche outils est devenue gratuite chez des concurrents hébergés (Composio « For You »), et les connecteurs grand public sont natifs dans Claude et ChatGPT ;
- la mémoire est le terrain où les clients natifs sont les plus forts ;
- les skills restent cloisonnés par client, sans API de synchronisation, et la v0.23 a fait de Kebab un hub de skills qui sert une seule bibliothèque à tous les clients ;
- claude.ai ne transmet pas les `instructions` MCP au modèle et ne gère pas l'elicitation ; ChatGPT limite les connecteurs personnels des particuliers.

## Decision

1. **Vitrine open source, side project personnel.** Pas de produit hébergé, pas de support non-dev. L'option produit reste documentée, non planifiée.
2. **Nom : Kebab House.** Tagline : « Create your personal AI brain with all the ingredients, and eat it everywhere. » Le dépôt (`kebab-mcp`), les variables d'environnement et les clés KV ne changent pas.
3. **Les skills d'abord, puis le profil, la mémoire et la confiance.** Le gel des connecteurs couverts par le natif est assumé.
4. **Promesse honnête** : Claude, Claude Code, Cursor, Codex en plein ; ChatGPT en partiel.
5. **Public : des templates de rituels**, pas la bibliothèque personnelle de l'auteur.
6. **Plan complet** en quatre phases, chacune livrée jusqu'au merge ; les points d'étape entre phases sont jugés « au feeling ».

## Consequences

- Les priorités techniques suivent les quatre cahiers des charges : profil et rituels (0), confiance et OAuth (1), installation et vault sans GitHub (2), MCP Apps et récap (3).
- Les nouveaux connecteurs ne sont plus une priorité ; LinkedIn et WhatsApp restent maintenus.
- Les compteurs d'outils disparaissent des arguments marketing.
