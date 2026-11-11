# Cahier des charges — Remédiation technique Kebab MCP (v2)

> Source : `docs/audits/2026-11-audit-technique.md`. Ce document traduit les constats en exigences testables, avec arbitrages.
> Rôle de décision : CTO. Contrainte dure : **aucune régression fonctionnelle** pour une instance existante (notamment le mode « KV-only » : jeton bootstrap + identifiants en Upstash, sans `MCP_AUTH_TOKEN` en env).

## 1. Objectifs

1. Fermer toutes les failles critiques/élevées et la majorité des moyennes.
2. Rendre le comportement correct en serverless multi-lambda (caches, invalidation, concurrence).
3. Rendre la CI digne de confiance (gates qui bloquent vraiment, tests hermétiques).
4. Réduire la dette là où le ratio risque/bénéfice est bon ; documenter explicitement ce qui est reporté.

Hors périmètre : nouvelles fonctionnalités, refonte UI, changement de plateforme.

## 2. Principes d'arbitrage

- **Secure by default, compat par opt-in explicite** : quand un durcissement casse un usage légitime, le défaut devient sûr et une variable `KEBAB_*` documentée permet de revenir à l'ancien comportement.
- **Fail-closed sur les états anormaux** (entrée corrompue, jeton révoqué), **fail-open conservé sur l'état « non configuré »** (absence de scope = accès complet) car c'est le contrat documenté et le cas des instances existantes.
- **Chaque correctif de sécurité est accompagné d'un test qui reproduit l'exploit.**
- Les refactors purement structurels sans gain de sûreté (découpage de gros fichiers) sont reportés.

## 2bis. Changements v1 → v2 (revue critique indépendante)

La v1 a été relue par un ingénieur indépendant contre le code. Corrections retenues :

1. **SEC-02** : aucune route admin HTTP n'exporte ; seul le CLI `scripts/backup.ts` le fait. Le CLI exporte donc **avec** les secrets par défaut (sinon une restauration d'une instance KV-only perd son jeton bootstrap et redevient réclamable). Le filtrage s'applique aux outils MCP.
2. **SEC-03** : le sélecteur de scope masquait tous les connecteurs core ; `admin` devient explicitement sélectionnable.
3. **Nouveau SEC-03b** : `setDeviceLabel` réécrivait l'entrée sans `connectors` → **renommer un jeton scopé lui rendait l'accès complet**. Corrigé + test d'exploit.
4. **SEC-04/06** : « entrée absente ⇒ accès complet » est conservé explicitement (le jeton bootstrap n'a jamais d'entrée `devices:`). « Corrompu » = JSON invalide ou `connectors` présent mais pas un tableau de chaînes. Résolution tri-état `revoked | full | scoped` faite dans `token-scope.ts` (pas dans `checkMcpAuth`, synchrone et partagé avec le proxy edge). Pour neutraliser l'en-tête tenant, le scope est lu dans l'espace racine **et** dans l'espace tenant, et le plus restrictif s'applique (pas de nouveau champ à propager).
5. **SEC-06** : la rotation ne concerne que les jetons de `MCP_AUTH_TOKEN` ; le jeton bootstrap (mode KV-only) n'est pas concerné — documenté, pas de rotation KV-native dans ce lot.
6. **SEC-11** : la route webhook n'hydrate pas les identifiants KV ; un secret saisi au dashboard n'était jamais vu. Ajout de l'étape d'hydratation **avant** le passage en fail-closed.
7. **SEC-07** : le vrai trou est l'acceptation à vie de tout cookie de claim signé, y compris **après** initialisation (`starter-skills`, `storage/status`). Le claimer n'est accepté que si l'instance n'est pas initialisée et que le `claimId` correspond au claim persisté. `/api/health` garde le champ `bootstrap` (l'onglet Santé et la bannière le lisent) ; seul l'état `pending` est masqué aux requêtes non authentifiées.
8. **SEC-12** : la règle SEC-A-03 ne vise que `MCP_AUTH_TOKEN` en env ; le jeton bootstrap reste un fallback admin valide (utilisateurs zéro-config).
9. **SEC-05** : le scope et les outils désactivés sont placés dans un contexte d'exécution (AsyncLocalStorage) par le wrapper MCP ; absence de contexte ⇒ pas de filtre uniquement pour les routes admin de test. La validation Zod des étapes est appliquée.
10. **Ajouts** : timeout outil plafonné à `maxDuration − 5 s` ; suppression du `process.exit` en requête ; clients singletons indexés par identifiants ; correction du marqueur de migration v0.10 (sans toucher au shim v0.11 encore utilisé).
11. **DNS pinning** : jugé à risque sur Vercel (undici userland vs fetch natif). Arbitrage : redirections manuelles revalidées + nettoyage d'en-têtes + formes IPv6 dans ce lot ; épinglage DNS **reporté**.
12. **CAS** : écriture conditionnelle par script Lua conservant le format blob, propagée à travers les wrappers tracing et tenant.
13. **Tests** : une suite de contrat « KV-only » (pas de `MCP_AUTH_TOKEN`, bootstrap + `cred:*` en KV, `ADMIN_AUTH_TOKEN` défini) est exigée.
14. **Ordre** : tests hermétiques avant SEC-08 ; gate d'audit avec la montée OTel ; mises à jour du snapshot de contrat et des compteurs de doc avec SEC-01.

## 3. Exigences — Sécurité

| ID | Exigence | Critères d'acceptation |
|---|---|---|
| SEC-01 | Les outils `mcp_backup_export`/`mcp_backup_import` ne sont plus exposés via MCP sauf `KEBAB_MCP_BACKUP_TOOLS=1`. | `tools/list` ne les contient pas par défaut ; test. |
| SEC-02 | `exportBackup` exclut par défaut les préfixes sensibles (`cred:`, `mymcp:firstrun:`, `devices:`, `tenant:` hors scope all, clés de rate-limit) ; `importBackup` refuse d'écrire ces préfixes sauf option explicite `includeSecrets` réservée à la route admin HTTP. | Tests export/import. |
| SEC-03 | Le connecteur `admin` n'est plus « core » : un jeton scopé ne l'obtient que s'il est dans son allowlist. `skills` reste core. | Test scope. |
| SEC-03b | `setDeviceLabel` préserve `connectors` (et `revokedAt`). | Test : renommer un jeton scopé ne change pas son scope. |
| SEC-04 | Le scope d'un jeton provenant de la liste globale est résolu dans l'espace racine, quel que soit l'en-tête tenant. Entrée corrompue ⇒ scope = core uniquement (fail-closed) + log. | Test : jeton scopé + `x-mymcp-tenant: x` ⇒ toujours scopé. |
| SEC-05 | Custom Tools : chaque étape revérifie le scope du jeton appelant, les outils désactivés, et valide ses arguments par le schéma Zod de l'outil cible. | Tests : étape hors scope refusée ; étape désactivée refusée ; arguments invalides refusés. |
| SEC-06 | Rotation de jeton : nouvelle entrée écrite avant toute suppression ; l'ancienne devient `revoked` et est refusée à l'auth MCP même si encore présente en env. | Test : ancien jeton refusé après rotation. |
| SEC-07 | First-run : claim persisté atomiquement (SETNX KV si disponible), cookie HMAC avec séparation de domaine et expiration vérifiée serveur ; `KEBAB_SETUP_TOKEN` optionnel exigé pour réclamer ; `/api/health` public n'expose plus l'état `pending` (seulement en mode authentifié). | Tests claim concurrent, cookie expiré, setup token. |
| SEC-08 | `safeFetch` central : redirections manuelles revalidées à chaque saut, suppression des en-têtes sensibles (Authorization, Cookie, en-têtes d'auth custom) au changement d'origine, épinglage DNS (lookup validant), formes IPv6 dangereuses bloquées. Utilisé par : connecteur API, paywall, skills distantes, lnkd.in, save-article. | Tests 302→IP privée, cross-origin header strip, IPv6. |
| SEC-09 | Connecteur API : chemins encodés (`encodeURIComponent`), corps JSON construit par sérialisation des valeurs (pas de concaténation brute). | Tests injection chemin/JSON. |
| SEC-10 | Cookies paywall envoyés uniquement aux hôtes correspondant à la source ; `save-article` détecte Medium par hostname. | Tests. |
| SEC-11 | Webhooks : signature obligatoire ; `KEBAB_WEBHOOK_ALLOW_UNSIGNED=1` pour l'ancien comportement ; alias `KEBAB_WEBHOOK_SECRET_<NAME>`. | Tests. |
| SEC-12 | Proxy edge aligné sur SEC-A-03 (pas de fallback MCP→admin en prod sans opt-in) ; `?token=` multi-jetons correct ; `x-request-id` validé. | Tests proxy. |
| SEC-13 | Browser : `web_act`/`web_agent` refusent le contexte `linkedin` sauf `KEBAB_BROWSER_LINKEDIN_WRITE=1`. | Test. |
| SEC-14 | Vault : recherche sans qualificatifs GitHub injectables ; écriture interdite sous `.github/` et `.git*` ; YAML via parseur durci. | Tests. |
| SEC-15 | Faibles : comparaison temps constant du secret cron ; `/api/welcome/test-mcp` réservé au claimer/admin ; `serializeEnv` rejette les caractères de contrôle ; cookie OAuth `Secure` ; `Cache-Control: no-store` sur les réponses à secrets ; HSTS hors Vercel. | Tests unitaires ciblés. |
| SEC-16 | Apify `run_actor` marqué `destructive: true` ; si `APIFY_ACTORS` vaut `*` ou est défini, comportement inchangé ; s'il est absent, l'outil reste ouvert (marketplace assumé, usage documenté) — arbitrage : pas de rupture pour les agents existants. | Snapshot contrat mis à jour. |

## 4. Exigences — Fiabilité serverless

| ID | Exigence | Critères |
|---|---|---|
| REL-01 | Tous les caches process-wide dépendant de données tenant (skills, API connections/tools, custom tools, prime, instance config) sont indexés par tenant. | Test : tenant B ne voit jamais les outils de A. |
| REL-02 | Compteur `kebab:rev:config` (INCR) incrémenté à chaque écriture d'identifiants/skills/outils ; chaque requête le compare (cache 2 s) et invalide hydratation et caches. | Test : suppression d'identifiant vue par une autre « lambda » simulée. |
| REL-03 | Écritures des collections blob (skills, custom tools, API) en compare-and-set (`kv.cas` via EVAL Upstash, mutex local en filesystem) avec retry borné. | Test concurrence : aucune perte d'écriture. |
| REL-04 | Suppression de la migration v0.10 (marqueur jamais reconnu ⇒ scan à chaque cold start). | Plus d'appel au démarrage. |
| REL-05 | Travail post-réponse (log durable, webhook d'erreur) via `after()`. | Test. |
| REL-06 | Métriques : store durable prioritaire si activé. | Test. |
| REL-07 | Avertissement explicite si rate limit actif sur Vercel sans Upstash. | Log + statut dashboard. |
| REL-08 | Rate limit LinkedIn du browser en KV (`incr` + TTL) au lieu de commits Git. | Test. |
| REL-09 | Cache du registre réellement utilisé (invalidé par REL-02) ; outils désactivés lus sans `KEYS`. | Test : pas de `list()` sur le chemin chaud. |
| REL-10 | TTL / plafonds : `unipile:outbox:*` (30 j), versions de skills (50). | Tests. |

## 5. Exigences — CI, supply chain, qualité

| ID | Exigence |
|---|---|
| CI-01 | Gate d'audit échoue si un `reviewBy` est dépassé ; grappe OpenTelemetry mise à jour ; allowlist nettoyée. |
| CI-02 | Workflows : `permissions: contents: read`, `concurrency`, `timeout-minutes`, actions épinglées par SHA. |
| CI-03 | Matrice Node 22/24 ; `engines.node >= 22`. |
| CI-04 | `dependabot.yml` valide (une entrée npm groupée + github-actions). |
| CI-05 | Tests hermétiques (`unstubEnvs`, DNS mocké) ; 0 échec en local hors réseau. |
| CI-06 | `test:ui` exécuté en CI ; couverture étendue à `app/**` et `proxy.ts` avec seuils lignes/branches/fonctions calés sur la mesure. |
| CI-07 | ESLint `--max-warnings 0` ; règles `no-floating-promises`/`no-misused-promises` sur `src/` et `app/api`. |
| CI-08 | knip : points d'entrée réels ; findings traités. |
| CI-09 | Dockerfile : suppression de la double installation, image de base épinglée. |
| Q-01 | Plus d'erreur avalée silencieusement dans les stores custom-tools/skills/signing-secret : dernier état valide conservé + log. |
| Q-02 | `tool-schema` : utiliser l'API publique `z.toJSONSchema` au lieu de `_zod`. |
| Q-03 | Alias `KEBAB_*` pour les variables `MYMCP_*` restantes ; en-tête `x-kebab-tenant` accepté. |
| DOC-01 | `ARCHITECTURE.md`, `SECURITY.md`, `.env.example`, changelog : nouvelles variables, comportements et ruptures. |

## 5bis. Plan de livraison et vérification

- Un seul PR structuré en commits par exigence, CI complète verte avant merge.
- Après merge : vérification du build et des journaux Vercel, puis propagation sur le fork `cadens-lab/kebab-mcp-yass` (merge de `main` amont) et contrôle de l'instance : `/api/health`, `tools/list` via MCP, absence d'erreurs runtime, comparaison au point de référence (0 erreur sur 7 jours avant intervention).
- Checklist variables pour l'instance du propriétaire : aucune nouvelle variable requise. `KEBAB_MCP_BACKUP_TOOLS`, `KEBAB_WEBHOOK_ALLOW_UNSIGNED`, `KEBAB_BROWSER_LINKEDIN_WRITE`, `KEBAB_SETUP_TOKEN` sont optionnelles.

## 6. Reporté (arbitrage)

- Épinglage DNS (undici `Agent`) — voir 2bis-11.
- Encadrement du contenu non fiable renvoyé au LLM (§2.8 de l'audit) — change la sortie de tous les outils, à concevoir avec les clients.
- Overrides `undici`, épinglages natifs `optionalDependencies`, `legacy-peer-deps` et régénération du lockfile — traités seulement si le build le permet sans risque.
- Rotation native du jeton bootstrap (KV-only).

- Construction du serveur MCP mise en cache par requête — gain de perf, risque élevé avec `mcp-handler`.
- Résolveur de configuration unique (suppression des mutations `process.env`) — refonte transverse ; partiellement couvert par REL-02.
- Découpage `notion-api.ts`, `kv-store.ts`, gros onglets UI ; pipeline `runGuardedWrite` Unipile ; `fetchWithRetry` commun — structurels, sans gain de sûreté immédiat.
- `preview_id` serveur pour Unipile — change le contrat des agents existants ; garde-fous actuels (rate limit, dédup, audit, kill switch) jugés suffisants à court terme.
- Isolation des outils browser dans une route dédiée.

## 7. Bilan de réalisation

| Exigence | Statut | Commit / note |
|---|---|---|
| SEC-01 à SEC-06 (backup, scope admin, renommage, en-tête tenant, Custom Tools, rotation) | ✅ | `fix(security): close MCP token privilege escalations` |
| SEC-07 (first-run) | ✅ | Claim persisté (SETNX), cookie v2 à expiration serveur, `KEBAB_SETUP_TOKEN` |
| SEC-08 (safeFetch, IPv6, point final) | ✅ sauf épinglage DNS | Épinglage reporté (cf. §6) |
| SEC-09, SEC-10 | ✅ | Encodage chemin/corps, portée des cookies |
| SEC-11 à SEC-15 | ✅ | Webhooks, proxy, browser, vault, faibles |
| SEC-16 (Apify) | ✅ déjà conforme | `run_actor` était déjà `destructive: true` |
| REL-01, REL-02, REL-04, REL-05 | ✅ | Caches par tenant, révision KV, migration, `after()` |
| REL-03 (CAS sur les collections) | ⏸ reporté | Voir arbitrage ci-dessous |
| REL-06 à REL-08, REL-10 | ✅ | Métriques durables, avertissement rate limit, compteur LinkedIn en KV, TTL outbox |
| REL-09 | ✅ partiel | `SCAN` au lieu de `KEYS` + timeout Upstash ; cache du registre laissé tel quel |
| CI-01 à CI-09 | ✅ | Gate d'audit (0 vulnérabilité prod), workflows durcis, Node 22/24, tests hermétiques, UI en CI, couverture `app/` + `proxy.ts`, ESLint typé, knip réel, Docker |
| Q-01, Q-02, Q-03 | ✅ | Stores sans perte silencieuse, JSON Schema public, alias `KEBAB_*` |
| DOC-01 | ✅ | `ARCHITECTURE.md`, `SECURITY.md`, `.env.example`, `content/docs/storage.md` |

### Arbitrages pris pendant l'implémentation

- **REL-03 (CAS)** reporté : les écritures concernées sont rares et réservées à l'admin (dashboard mono-opérateur). La lecture corrompue → `[]` → écrasement, le vrai risque de perte de données, est corrigée par Q-01. Un CAS Lua introduirait une rupture de format côté FilesystemKV pour un gain marginal.
- **Cache du registre** : la reconstruction à chaque requête ne refait que le filtrage par variables d'env (sans E/S, manifests déjà mis en cache) ; le gain est négligeable.
- **Timeout outil vs plan Vercel** : aucune variable ne permet de détecter le plafond Hobby (60 s). Le défaut de 80 s est conservé et documenté.
- **`process.exit` sur variables destructives** : conservé, c'est un arrêt volontaire (fail-fast) documenté.
- **URI de redirection OAuth basée sur `VERCEL_URL`** : inchangée ; la modifier casserait les URI déjà enregistrées chez Google par les utilisateurs.
- **Régression évitée** : la règle « plus aucun cookie de claim dès que `MCP_AUTH_TOKEN` existe » bloquait le propriétaire légitime sur Docker (le welcome écrit lui-même cette variable). La règle finale ne garde que le claim qui a émis le jeton bootstrap.
