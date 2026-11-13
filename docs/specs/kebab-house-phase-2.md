# Cahier des charges — Kebab House, phase 2 : l'install en quelques clics

> Source : brief vision « Kebab House » (13 novembre 2026). Phase 2 sur 4. Prérequis : phases 0 et 1 livrées.
> Contrainte dure : **aucune régression** pour une instance existante, en particulier les forks qui se mettent à jour par `merge-upstream` et les vaults GitHub.

## 1. Contexte

L'installation recommandée est aujourd'hui « Fork + Import Vercel », puis attacher Upstash à la main. Le Deploy Button Vercel (`/new/clone`) ferait tout en un lien, Upstash compris (paramètre `stores`, intégration `upstash` / produit `upstash-kv`). Il a été abandonné en avril 2026 pour une seule raison : il crée un clone sans lien de fork, et la mise à jour du dashboard repose sur `merge-upstream`, qui refuse les clones (`app/landing/deploy-url.ts`, `app/api/config/update/route.ts`).

Second frein : le vault exige `GITHUB_PAT` et `GITHUB_REPO`. Sans eux, pas de mémoire, et le profil de la phase 0 reste le seul « cerveau ». Troisième manque : il n'existe pas d'export complet (KV sans secrets + vault + skills) qu'on puisse ouvrir ailleurs.

## 2. Objectifs

1. Une mise à jour qui marche pour les clones, sans casser celle des forks.
2. Un Deploy Button qui crée projet, dépôt et Upstash en un passage, puis amène sur `/welcome`.
3. Un vault utilisable dès l'installation, sans GitHub, stocké dans le KV, avec GitHub en option.
4. Un export complet téléchargeable, et un import du vault GitHub vers le KV.

Hors périmètre : installeur sans Git via « Sign in with Vercel » (option produit), Blob Vercel (non nécessaire si le vault vit dans le KV), hébergement pour des tiers.

## 3. Exigences — Mise à jour des clones

| ID | Exigence | Critères d'acceptation |
|---|---|---|
| UPD-01 | Nouveau mode de mise à jour `release-sync` utilisé quand le dépôt déployé n'est pas un fork (`not-a-fork` aujourd'hui). Principe : comparer, via l'API GitHub `compare`, le commit amont de la version installée et le commit amont cible ; pour chaque fichier modifié en amont, créer le blob dans le dépôt de l'utilisateur ; créer un arbre (`base_tree` = arbre courant de l'utilisateur, fichiers supprimés retirés) ; créer un commit « chore: sync Kebab House vX.Y.Z » ; avancer `main`. Vercel redéploie sur ce push. | Tests avec API GitHub simulée : ajout, modification, suppression, renommage. |
| UPD-02 | La version amont installée est connue sans ambiguïté : le commit de build (`VERCEL_GIT_COMMIT_SHA`) n'étant pas un commit amont dans un clone, la version est lue dans `package.json` / `VERSION` et associée au tag de release amont correspondant. | Test : version → tag → commit. |
| UPD-03 | **Conflits** : si un fichier à mettre à jour a été modifié par l'utilisateur (son blob diffère du blob amont de la version installée), la synchro s'arrête avant toute écriture et liste les fichiers en conflit, avec la marche à suivre. | Test : aucun commit créé en cas de conflit. |
| UPD-04 | Les forks gardent `merge-upstream` (inchangé). Le dashboard affiche le mode utilisé. Le jeton requis reste `KEBAB_UPDATE_PAT` (`contents: write` sur le dépôt de l'utilisateur), avec un message d'aide si absent. | Tests du choix de mode. |
| UPD-05 | Limites : au plus 500 fichiers et 20 Mo par synchro ; au-delà, message clair et lien vers la mise à jour manuelle. Appels GitHub séquencés pour rester sous les limites de débit ; échec à mi-parcours sans effet visible (la référence n'est déplacée qu'à la fin). | Test d'échec à mi-parcours. |

## 4. Exigences — Deploy Button

| ID | Exigence | Critères d'acceptation |
|---|---|---|
| DEP-01 | Constante `VERCEL_DEPLOY_BUTTON_URL` : `https://vercel.com/new/clone?repository-url=<dépôt>&project-name=kebab-house&repository-name=kebab-house&stores=[{"type":"integration","integrationSlug":"upstash","productSlug":"upstash-kv"}]` (JSON encodé). Le commentaire de `deploy-url.ts` est réécrit pour expliquer pourquoi le bouton redevient possible (UPD-01). | Test de génération de l'URL (décodage + JSON valide). |
| DEP-02 | Page `/deploy` : le bouton devient le parcours recommandé ; « Fork + Import » reste documenté comme alternative ; Docker inchangé. La page dit ce qui sera créé (dépôt, projet, base Upstash gratuite) et ce qui reste à faire (jeton de mise à jour, facultatif). | Capture. |
| DEP-03 | `/welcome` détecte une instance fraîchement créée avec Upstash déjà branché et saute l'étape de stockage. Fin du parcours : bouton « Ajouter à Claude » et phrase d'amorçage (phase 1). | Test du saut d'étape. |
| DEP-04 | README et landing : le bouton « Deploy » pointe vers le Deploy Button. | Revue. |
| DEP-05 | Retour automatique vers l'instance après déploiement (`redirect-url`) : **non réalisé** dans cette phase, car il exige d'enregistrer une intégration Vercel (action manuelle du propriétaire du compte). Documenté comme amélioration possible. | Doc. |

## 5. Exigences — Vault sans GitHub

| ID | Exigence | Critères d'acceptation |
|---|---|---|
| VLT-01 | Interface `VaultBackend` : `read`, `write`, `delete`, `move`, `list`, `tree`, `search`, `recent`, `stats`, `health`. Les 13 outils du vault passent par elle, avec des sorties inchangées. | Tests existants du vault verts sur le backend GitHub. |
| VLT-02 | Backend `github` = code actuel déplacé derrière l'interface. | Tests existants. |
| VLT-03 | Backend `kv` : une clé par note (`vault:note:<chemin>` → contenu, date de modification, taille), un index (`vault:index` : chemin, titre, date, taille, liens sortants) mis à jour à chaque écriture. Limites : 256 Ko par note, 5 000 notes ; avertissement au-delà de 50 Mo au total. Recherche : correspondance insensible aux accents sur titres puis contenus, plafonnée. `recent` par date de modification ; `backlinks` par l'index des liens. Fonctionne sur Upstash et sur le KV fichier (Docker). | Tests unitaires du backend avec le KV mémoire. |
| VLT-04 | Sélection : `github` si `GITHUB_PAT` et `GITHUB_REPO` sont présents, sinon `kv`. Le connecteur vault devient actif par défaut (sans variable requise). Forçage possible par `KEBAB_VAULT_BACKEND=github\|kv`. | Tests de sélection ; test registry. |
| VLT-05 | Validation de chemin identique au backend GitHub (pas de `..`, pas de `.git*`, pas de `.github/`). | Tests. |
| VLT-06 | Import du vault GitHub vers le KV (bouton dans `/config`, admin) : copie des fichiers Markdown, rapport (copiés, ignorés, trop gros). Le basculement reste un choix explicite. | Test avec API GitHub simulée. |
| VLT-07 | `my_context` (phase 0) en mode `vault` lit via l'interface, quel que soit le backend. | Test. |

## 6. Exigences — Export complet

| ID | Exigence | Critères d'acceptation |
|---|---|---|
| EXP-01 | `GET /api/config/export` (admin, `Cache-Control: no-store`) renvoie un zip : `kebab-house.json` (KV filtré : sans `cred:*`, `oauth:*`, `devices:*`, claims first-run, rate-limit, compteurs), `vault/**.md` (tout backend), `skills/<nom>/SKILL.md` + fichiers, `profiles/<nom>.md`, `README.txt` expliquant comment réimporter. | Test : zip lisible, aucun secret présent (recherche des préfixes). |
| EXP-02 | Bouton « Exporter tout » dans `Settings`. | Capture. |
| EXP-03 | Import du zip vers une nouvelle instance (profils, skills, vault) par la route d'import existante des skills et une route d'import de vault ; le KV filtré n'est pas réimporté automatiquement (documenté). | Test d'aller-retour skills + vault. |

## 7. Plan de livraison et vérification

1. Deux PR : (a) mise à jour des clones + Deploy Button + welcome, (b) vault KV + export.
2. Avant chaque PR : typecheck, lint, `npm test`, build.
3. Vérifications bout en bout : synchro de release sur un dépôt GitHub simulé (tests) ; parcours `/deploy` en capture ; instance locale sans GitHub : `vault_write`, `vault_search`, `vault_recent`, `vault_backlinks`, `my_context` en mode vault, export puis lecture du zip.
4. Après merge : vérification de la production (`/api/health`, page `/deploy`).

## 8. Risques et arbitrages

- **Écriture dans le dépôt de l'utilisateur** : la synchro crée des commits ; elle n'agit qu'à la demande depuis le dashboard, jamais automatiquement.
- **Vault dans Redis** : bon pour un usage personnel (quelques milliers de notes) ; pas un moteur de recherche. GitHub reste disponible pour qui veut Obsidian.
- **Deploy Button non testable de bout en bout ici** : il exige un compte Vercel tiers. La génération de l'URL est testée ; le parcours réel est à vérifier par le propriétaire au premier usage.
