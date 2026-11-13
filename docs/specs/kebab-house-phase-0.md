# Cahier des charges — Kebab House, phase 0 : le hub au quotidien

> Source : brief vision « Kebab House » (13 novembre 2026). Phase 0 sur 4.
> Contrainte dure : **aucune régression** pour une instance existante (mode KV-only, jetons statiques, vault GitHub, skills v2).

## 1. Contexte

La v0.23 a livré le hub de skills (format Agent Skills, `skills_list` / `skill_load`, tags par jeton). Trois manques empêchent de le vivre au quotidien :

1. **Le profil n'est pas lu.** Le dashboard stocke un profil inline dans le KV (`mymcp:context:inline`), mais l'outil `my_context` lit en dur `System/context.md` dans le vault GitHub (`src/connectors/vault/tools/my-context.ts`). Sans vault, l'outil n'existe même pas.
2. **Rien ne déclenche le hub sur claude.ai.** Le catalogue est publié dans les `instructions` MCP, que claude.ai et Claude Desktop ne transmettent pas au modèle (anthropics/claude-ai-mcp#93). Le canal B (skills relais) existe, mais s'installe skill par skill.
3. **Rien ne se voit.** Les 3 `STARTER_SKILLS` sont des utilitaires génériques, et aucun compteur ne dit si le hub sert.

Décisions du brief appliquées ici : nom **Kebab House**, tagline « Create your personal AI brain with all the ingredients, and eat it everywhere », des **templates** publics (pas les skills de l'auteur), jugement de la phase « au feeling » éclairé par des compteurs.

## 2. Objectifs

1. Un profil toujours disponible, sans vault, et un profil par casquette.
2. Un pack de rituels livré comme templates, installables en un clic.
3. Un relais maître qui rend la bibliothèque déclenchable sur claude.ai et ChatGPT avec une seule installation.
4. Des compteurs d'usage hebdomadaires visibles dans le dashboard.
5. Le nom et la promesse Kebab House dans le README, la landing et le dashboard.

Hors périmètre : OAuth, onboarding conversationnel, modèle de confiance (phase 1) ; vault sans GitHub (phase 2) ; MCP Apps (phase 3).

## 3. Exigences — Profil (contexte)

| ID | Exigence | Critères d'acceptation |
|---|---|---|
| CTX-01 | Nouveau connecteur **core** `context` (toujours chargé, exempté de scope comme `skills`) qui porte `my_context`. Le vault n'enregistre plus `my_context` (pas de doublon de nom). | `tools/list` d'une instance sans `GITHUB_PAT` contient `my_context` ; avec vault, une seule occurrence. Test registry + contrat. |
| CTX-02 | Ordre de résolution de `my_context` : (1) profil lié au jeton appelant ; (2) profil par défaut (inline KV si le mode est `inline`) ; (3) fichier du vault au chemin configuré (`contextPath`, plus de chemin en dur) si le mode est `vault` et le vault actif ; (4) message d'aide pointant vers `/config → Settings → Profil`. | Tests unitaires des 4 branches. |
| CTX-03 | **Profils par casquette** : jusqu'à 20 profils nommés (slug `a-z0-9-`, ≤ 40 caractères), chacun ≤ 32 Ko de Markdown, stockés sous une clé KV tenant-scopée. Le profil « default » correspond au profil inline existant (migration implicite, aucune réécriture). | Tests store : CRUD, limites, slug invalide refusé, lecture du legacy inline comme `default`. |
| CTX-04 | Un jeton (device) peut être lié à un profil (`profile` sur l'entrée device, préservé par toutes les écritures existantes comme `connectors` et `skillTags`). Profil inexistant ⇒ repli sur `default`, jamais d'erreur. | Tests devices : renommer / rotation / changer le scope conservent `profile`. |
| CTX-05 | Outil `my_context_update` (`destructive: true`) : `mode: "append" \| "replace"`, `content`, cible = profil du jeton appelant (sinon `default`). Refus si la taille finale dépasse la limite. Écrit toujours dans le KV, jamais dans le vault. | Tests : append, replace, dépassement, profil lié. |
| CTX-06 | Dashboard : `Settings → Profil` gère les profils (liste, créer, éditer, supprimer, choisir le défaut) ; `Devices` permet de choisir le profil d'un jeton à côté des tags de skills. Le mode vault existant reste disponible pour `default`. | Test UI (vitest UI) du formulaire ; capture Playwright. |
| CTX-07 | La description de `my_context` dit quand l'appeler (« au début d'une tâche personnelle, pour connaître l'utilisateur, ses projets, ses préférences ») et que le profil peut être mis à jour par `my_context_update` sur demande explicite de l'utilisateur. | Revue du texte. |

## 4. Exigences — Rituels (templates)

| ID | Exigence | Critères d'acceptation |
|---|---|---|
| RIT-01 | 5 templates au format Agent Skills dans `content/skill-templates/<name>/SKILL.md` : `remember` (retiens ça), `morning-brief`, `meeting-prep`, `weekly-review`, `read-later`. Frontmatter : `name`, `description` (≤ 1024 car.), `metadata.tags: [rituals]`. Ils n'appellent que des outils génériques (`my_context`, `my_context_update`, `vault_*`, `save_article`, `skills_list`) et dégradent proprement quand un outil manque (« si un outil d'agenda est disponible… »). | Test : chaque template se parse avec l'importeur existant sans avertissement bloquant. |
| RIT-02 | Les templates remplacent `STARTER_SKILLS` dans `/api/welcome/starter-skills` (même contrat GET/POST) et sont proposés dans l'onglet Skills (« Templates ») avec un bouton Installer. L'installation passe par le chemin d'import existant (versionnage, mise à jour au lieu de doublon). | Test route ; test install idempotente. |
| RIT-03 | Les templates installés portent le tag `rituals` ; un jeton scopé par tags ne les voit que s'il a ce tag (comportement existant). | Test scope. |
| RIT-04 | Les anciens starter skills déjà installés chez un utilisateur ne sont ni supprimés ni modifiés. | Test : store pré-rempli inchangé. |

## 5. Exigences — Relais maître

| ID | Exigence | Critères d'acceptation |
|---|---|---|
| RLY-01 | Export `GET /api/config/skills/relay-master` (admin) : un zip contenant `kebab-house/SKILL.md`. Sa `description` (≤ 1024 car.) dit quand l'utiliser et énumère les noms des skills visibles (tronqués proprement). Son corps demande : appeler `my_context`, puis `skills_list`, choisir, `skill_load`, suivre. Il précise « si le connecteur Kebab House est absent, dis-le et arrête ». | Test : zip valide, frontmatter conforme, description ≤ 1024. |
| RLY-02 | Variante filtrée par tag (`?tag=perso`) pour les comptes séparés par casquette. | Test. |
| RLY-03 | Onglet Skills, panneau « Use everywhere » : bouton « Relais maître (.zip) » + 3 étapes d'installation pour claude.ai et ChatGPT, et le rappel qu'il faut le régénérer quand la liste change beaucoup. | Capture. |

## 6. Exigences — Compteurs d'usage

| ID | Exigence | Critères d'acceptation |
|---|---|---|
| USE-01 | À chaque appel d'outil réussi, incrémenter des compteurs de la semaine ISO courante : par outil, par client (libellé du device ou `tokenId`), et pour `skill_load` par skill. Écritures avec `kv.incr` (TTL 120 jours), en arrière-plan (`after()` ou fire-and-forget journalisé), jamais bloquantes ni fatales. | Test : un appel → compteurs incrémentés ; KV en erreur → l'outil répond quand même. |
| USE-02 | Compteur « notes ajoutées » : incrémenté par `vault_write`, `vault_append`, `save_article` et `my_context_update`. | Test. |
| USE-03 | Route admin `GET /api/config/usage?weeks=N` (1 ≤ N ≤ 12) : séries par semaine (total, top 10 outils, top 10 skills, clients, notes). | Test route. |
| USE-04 | Carte « Cette semaine » dans l'onglet Overview : appels, skills les plus chargés, clients actifs, notes, comparaison avec la semaine précédente. | Test UI ; capture. |
| USE-05 | Aucun contenu (arguments, textes) n'est stocké : seulement des noms d'outils, de skills et de clients. Désactivable par `KEBAB_USAGE_COUNTERS=off`. | Revue + test du flag. |

## 7. Exigences — Marque Kebab House

| ID | Exigence | Critères d'acceptation |
|---|---|---|
| BRD-01 | README : titre « Kebab House », tagline, paragraphe « ce que c'est / ce que ce n'est pas » (hub, pas agent), matrice honnête des clients (Claude, Claude Code, Cursor, Codex en plein ; ChatGPT partiel), compteurs exacts (le script `test:doc-counts` passe). | CI `test:doc-counts`. |
| BRD-02 | Landing (`app/landing/*`) : header, hero, footer et métadonnées (titre, OpenGraph) passent à Kebab House et à la tagline ; le hero met en avant les skills et le profil partagés, pas le nombre d'outils. | Capture Playwright desktop + mobile. |
| BRD-03 | Dashboard et welcome : le nom affiché devient Kebab House (constante de marque centrale). Les identifiants techniques (nom du dépôt, variables `MYMCP_*`/`KEBAB_*`, clés KV, préfixes de log) ne changent pas. | `grep` : aucune clé KV ni variable renommée ; tests existants verts. |
| BRD-04 | `serverInfo.name` MCP devient « Kebab House ». | Test transport. |

## 8. Plan de livraison et vérification

1. Une PR unique « feat: Kebab House phase 0 » sur `claude/modest-hawking-piskvr`, commits atomiques par bloc (CTX, RIT, RLY, USE, BRD).
2. Avant la PR : `npm run typecheck`, `npm run lint`, `npm test` (unit + UI + registry + contract + doc-counts), `npm run build`.
3. Vérification bout en bout locale : instance `next start` sans `GITHUB_PAT`, requêtes MCP réelles (`initialize`, `tools/list`, `my_context`, `my_context_update`, `skill_load`), puis `/api/config/usage`.
4. Captures Playwright : landing, Settings → Profil, Devices, Skills (templates + relais), Overview (carte usage).
5. Merge après CI verte ; vérification du déploiement de production (`/api/health` répond la nouvelle version).

## 9. Risques et arbitrages

- **Doublon `my_context`** : le déplacement hors du vault est le seul changement visible pour les utilisateurs du vault ; le nom de l'outil est conservé, le comportement reste identique en mode vault.
- **Coût KV des compteurs** : 2 à 3 `INCR` par appel d'outil. Sur l'offre gratuite Upstash (500 000 commandes/mois), c'est acceptable pour un usage personnel ; documenté avec le flag d'arrêt.
- **Relais maître moins précis** qu'un relais par skill : il déclenche sur l'intention générale « mes skills / ma façon de faire ». Les deux restent disponibles.
