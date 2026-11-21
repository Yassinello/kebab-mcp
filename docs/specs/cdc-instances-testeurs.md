# Cahier des charges — Instances privées et à jour pour les testeurs

> Statut : livré dans la release qui suit v0.1.18. Rôle de décision : mainteneur.
> Déclencheur : l'instance perso `cadens-lab/kebab-mcp-yass` est publique, ce qui a mis en lumière le modèle de déploiement des instances.

## 1. Contexte

Kebab House est auto-hébergé : chaque utilisateur déploie **sa** copie du repo `Yassinello/kebab-mcp` sur **son** Vercel, avec **sa** base Upstash. Il existe deux parcours Vercel :

| Parcours | Repo créé | Visibilité | Mise à jour depuis le dashboard |
|---|---|---|---|
| Bouton Vercel (`/new/clone`) | copie autonome (pas un fork) | au choix, peut être privée | *release sync* (`src/core/release-sync.ts`) |
| Fork + Import | fork GitHub de l'upstream | **toujours publique** | `merge-upstream` |

Cible : **quelques dizaines de testeurs, profil « vibe coder du dimanche »**. Ils ne lisent pas la doc Git, ne créent pas de token GitHub spontanément et ne surveillent pas leur repo.

### 1.1 Historique de l'instance perso (pourquoi elle est publique)

1. Instance initiale : `Yassinello/mymcp-yass`, copie privée (`docs/RENAME-MANUAL-STEPS.md`).
2. 28/04/2026 : « Update » cassé, car seul `merge-upstream` existait et GitHub le refuse aux non-forks (`app/landing/deploy-url.ts`).
3. Correctif d'alors : recréer l'instance en vrai fork. Impossible de forker dans le compte propriétaire de l'upstream, donc fork dans l'org `cadens-lab`. Un fork de repo public est public. Projet Vercel `kebab-mcp-yass` (équipe Cadens) créé le 27/04/2026 23:27 UTC.
4. 15/11/2026 (#73) : *release sync* met à jour les copies non-fork. La raison d'être du fork a disparu.

État constaté le 20/11/2026 : `main` du fork est identique à l'upstream (aucun commit propre) ; aucun secret dans Git (ils sont dans Vercel et Upstash).

## 2. Décision

**Un seul parcours pour les instances : le bouton Vercel (copie autonome, privable, release sync). Le fork est réservé aux contributeurs.**

Raisons :

- **Visibilité** : un fork est public de force, sans que l'utilisateur le sache. Le jour où il commite un `.env` ou une note perso, c'est exposé.
- **Mises à jour** : un fork modifié « diverge » et le bouton se bloque avec un lien de résolution Git. *Release sync* s'arrête proprement en listant les fichiers en conflit.
- **Installation** : le fork demande d'attacher Upstash à la main ; le bouton crée repo, projet et base en un clic.

Le fork garde un intérêt : l'historique partagé, utile pour proposer des PR.

Écarté pour ce lot : une offre hébergée (multi-tenant opéré par le mainteneur). Elle supprimerait la friction mais ferait détenir au mainteneur les tokens LinkedIn/Google/WhatsApp des testeurs, à l'opposé de la promesse « your tokens, never ours ». À réévaluer seulement si l'installation fait décrocher.

## 3. Points clés vérifiés

| # | Affirmation | Vérification | Statut |
|---|---|---|---|
| V1 | Un fork d'un repo public ne peut pas être rendu privé. | Doc GitHub (forks et visibilité) ; repo `cadens-lab/kebab-mcp-yass` = `fork: true`, `public`. | Vérifié |
| V2 | « Leave fork network » (Settings → Danger Zone) détache un fork public < 1 Go sans enfants ; irréversible ; perd issues/PR/étoiles ; garde l'historique. | Doc GitHub *Detaching a fork*. | Vérifié (doc) |
| V3 | Vercel Hobby ne déploie pas un repo **privé d'une org** GitHub (Pro requis). Repo privé perso : OK. | Forum Vercel (plusieurs fils concordants), pas de page de doc officielle trouvée. | Probable |
| V4 | Le bouton Vercel n'a pas de paramètre de visibilité du repo créé (`repository-url`, `project-name`, `repository-name`, `stores`…). L'`access: private` documenté concerne les stores Blob. | Doc Vercel *Deploy Button Source* (via l'index de doc Vercel). | Vérifié |
| V5 | Le flux `/new/clone` propose un repo privé par défaut. | Non documenté. | **Non vérifié** : à contrôler à la main sur le flux réel. Le produit dit seulement « peut rester privé », vrai dans tous les cas. |
| V6 | La dernière release upstream se lit sans token : `GET api.github.com/repos/Yassinello/kebab-mcp/releases/latest` (60 req/h/IP en anonyme) ; `github.com/.../releases/latest` répond 302 vers `/releases/tag/vX.Y.Z`. | Testé le 21/11/2026 : API → `v0.1.18` ; `fetch(..., {redirect:"manual"})` sous Node → `302` + `location` lisible. | Vérifié |
| V7 | Les IP de sortie des fonctions Vercel sont partagées, donc la limite anonyme de 60 req/h peut être atteinte. | Raisonnement (pas de garantie d'IP dédiée). | Hypothèse prudente → repli + cache (UPD-11) |
| V8 | Dans une expression GitHub Actions, `==` compare les chaînes sans tenir compte de la casse. | Doc GitHub *Expressions*. | Vérifié |
| V9 | Pour un `pull_request` venant d'un fork, `github.repository` vaut le repo **de base** : la garde laisse tourner la CI des PR de contributeurs. | Doc GitHub (contexte d'événement `pull_request`). | Vérifié |
| V10 | *Release sync* n'écrit jamais `.github/workflows/` (`EXCLUDED_PREFIXES`). | Code `src/core/release-sync.ts`. | Vérifié |
| V11 | Dependabot (version updates) s'active par la seule présence de `.github/dependabot.yml`, sans condition possible sur le repo. Désactivé par défaut sur les forks, actif sur les copies. | Doc GitHub Dependabot. | Probable → risque résiduel R3 |

## 4. Exigences

### 4.1 Parcours de déploiement (DEP)

| ID | Exigence | Critères d'acceptation |
|---|---|---|
| DEP-10 | La carte Fork de `/deploy` est étiquetée **For contributors** et porte un avertissement visible : « A fork is always public », avec renvoi vers le bouton pour une instance perso. | Test UI : libellé présent, `role="note"` contenant « a fork is always public », plus de libellé « Alternative ». |
| DEP-11 | La carte recommandée dit que la copie n'est pas un fork et **peut rester privée**. L'intro de page présente le fork comme le parcours contributeur. | Test UI : « can stay private » dans la carte recommandée. |
| DEP-12 | README (Quick Start), `content/docs/getting-started.md`, `docs/HOSTING.md` et l'appel à l'action de la landing reprennent ce positionnement. | Relecture ; plus aucune formulation présentant le fork comme alternative pour une instance perso. |

### 4.2 Mises à jour sans token (UPD)

| ID | Exigence | Critères d'acceptation |
|---|---|---|
| UPD-10 | `GET /api/config/update` sans token garde sa forme (`mode`, `reason: "no-token"`, `configureUrl`, `tokenConfigured: false`) et ajoute `available`, `installedVersion`, et si connus `latestVersion`, `releaseUrl`, `checkedAt`. `available` = la dernière release upstream est strictement supérieure à la version du build ; jamais de rétrogradation. | Tests route : release plus récente → `available: true` ; égale → `false` ; GitHub injoignable → forme d'origine, `available: false`. |
| UPD-11 | Lecture anonyme de l'upstream uniquement (jamais du repo de l'utilisateur, potentiellement privé). Source 1 : API REST ; repli : redirection `github.com/.../releases/latest`. Brouillons et pré-releases ignorés. Délai 5 s par source. Aucune exception ne remonte. | Tests unitaires `tests/core/upstream-release.test.ts` (API, 403 → repli, exception → repli, pré-release, double échec → `null`). |
| UPD-12 | Cache KV `global:upstream-release`, TTL 6 h ; `?force=1` (bouton « Check for updates », debounce 30 s côté client) l'ignore ; un échec n'est pas mis en cache ; une panne KV n'empêche pas la réponse. Le cron quotidien rafraîchit ce cache quand il n'y a pas de token. | Tests route (cache servi sans appel réseau, `force` relit, panne KV) et cron (écriture de la clé avec TTL 6 h). |
| UPD-13 | Dashboard : sans token et `available`, bannière orange « Kebab House vX available », « You run vY », lien « Add an update token → » et « What's new → », horodatage + ↻. Pas de bouton « Update now » (l'installation exige le token). Rien de nouveau si à jour. | Tests UI `tests/ui/overview-release-sync.test.tsx`. |

Hors périmètre UPD : supprimer complètement le besoin de token (piste : workflow de sync dans la copie avec le `GITHUB_TOKEN` d'Actions ; à valider, notamment le déclenchement du déploiement Vercel et les permissions sur `.github/workflows/`).

### 4.3 Workflows dans les copies (CI)

| ID | Exigence | Critères d'acceptation |
|---|---|---|
| CI-10 | Chaque job de `.github/workflows/*.yml` porte `if: github.repository == 'Yassinello/kebab-mcp'`. Les copies (bouton ou fork) ne consomment plus de minutes Actions ni n'envoient de mails d'échec. Les PR de contributeurs restent testées (V9). | Test de contrat `tests/contract/workflows-upstream-guard.test.ts` : tout job de tout workflow porte la garde. Sur l'upstream, la CI d'une PR s'exécute toujours. |

## 5. Risques et résiduels

| ID | Risque | Traitement |
|---|---|---|
| R1 | Copies existantes : *release sync* n'écrit pas `.github/workflows/` (V10), donc la garde CI-10 n'atteint pas les copies créées avant cette release. | Documenté (`docs/HOSTING.md`). Correctif manuel côté utilisateur : supprimer ou mettre à jour ses workflows. Pas d'automatisation (token sans permission *Workflows*). |
| R2 | Forks existants : `merge-upstream` doit cette fois propager des fichiers de workflow ; un token sans droit *Workflows* peut être refusé. | Les forks sont désormais le parcours contributeur ; le bouton *Sync fork* de GitHub reste disponible ; l'erreur d'auth est déjà affichée par le dashboard. |
| R3 | Dependabot ouvre des PR hebdomadaires dans les copies (V11). Une PR fusionnée par un testeur fait diverger `package.json` et bloque le *release sync* sur ces fichiers. | Non traité dans ce lot (aucune condition possible dans `dependabot.yml`). Piste : remplacer par un workflow gardé, ou documenter « ne pas fusionner, désactiver Dependabot ». |
| R4 | Limite anonyme GitHub (V7). | Cache 6 h + repli sans quota API + échec silencieux. |
| R5 | V5 non vérifié. | Formulation produit neutre ; contrôle manuel à faire sur le flux réel. |

## 6. Plan de mise en production

1. PR unique (DEP-10..12, UPD-10..13, CI-10, ce CDC), CI verte (lint, format, typecheck, knip, build, taille, couverture, UI, registre, contrat, intégration).
2. Fusion sur `main` → déploiement de la vitrine `kebab-mcp.vercel.app` ; contrôle : build READY, `/deploy` affiche la carte contributeurs, `/api/health` OK, pas d'erreur runtime.
3. Fusion de la PR release-please → release publiée (tag `vX.Y.Z`).
4. Propagation sur l'instance perso (`main` amont → fork), déploiement, contrôle `/api/health` (nouvelle version), journaux sans erreur.

## 7. Migration de l'instance perso (`cadens-lab/kebab-mcp-yass`)

Cible : repo privé, non-fork, mis à jour par *release sync* (même parcours que les testeurs).

Actions réservées au propriétaire (aucune API ne les expose) :

1. Vérifier le plan de l'équipe Vercel **Cadens** (V3). Hobby → passer en Pro, ou transférer le repo vers le compte perso `Yassinello`.
2. GitHub → `cadens-lab/kebab-mcp-yass` → Settings → Danger Zone → **Leave fork network**, puis **Change visibility → Private**.
3. Vercel → projet `kebab-mcp-yass` → Settings → Git : vérifier la connexion (reconnecter le même repo si besoin), redéployer.
4. Token de mise à jour : *classic* `repo` (plus `public_repo`) ou *fine-grained* « Contents: read & write » sur ce repo.
5. Contrôle : Overview → « Update mode : Release sync ».

Après détachement, l'historique complet est conservé : la base du *release sync* est déterminée par la version de `package.json` (repli `tag`), puis par la ligne `Kebab-Upstream-Commit` dès la première synchro. Pour tester `main` avant une release, pousser `main` amont à la main ; ne pas mélanger avec le *release sync* (faux conflits possibles).
