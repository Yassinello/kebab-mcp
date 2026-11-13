# Cahier des charges — Kebab House, phase 3 : rendre le hub visible

> Source : brief vision « Kebab House » (13 novembre 2026). Phase 3 sur 4. Prérequis : phases 0 à 2 livrées.
> Contrainte dure : **aucune régression** ; chaque vue interactive a un repli en texte pour les clients qui ne l'affichent pas.

## 1. Contexte

L'extension officielle MCP Apps (`io.modelcontextprotocol/ui`, stable depuis janvier 2026) permet à un serveur d'afficher une interface HTML dans le client. Elle est rendue par Claude (web et desktop ; rendu basique sur mobile), ChatGPT, Cursor et VS Code, pas par Claude Code. Un outil peut y être réservé à l'interface (visibilité « app »), donc invisible pour le modèle : c'est la bonne place pour une validation humaine.

La phase 0 a posé les compteurs d'usage, la phase 1 les validations d'envoi par lien signé. Il manque un endroit où l'utilisateur voit son hub travailler, sans quitter son client IA.

## 2. Objectifs

1. Trois vues MCP Apps : état du hub, validation d'un envoi, galerie de skills.
2. Un récap hebdomadaire, en outil et en rituel.
3. Une landing qui raconte Kebab House de bout en bout.

Hors périmètre : rendu mobile avancé, applications natives, notifications push.

## 3. Exigences — Socle MCP Apps

| ID | Exigence | Critères d'acceptation |
|---|---|---|
| APP-01 | Ressources `ui://kebab-house/<vue>` de type `text/html;profile=mcp-app`, servies par le mécanisme de ressources existant. HTML autonome : aucun script ni style externe, aucune donnée sensible embarquée (les données arrivent par l'outil). | Test : `resources/read` renvoie le HTML avec le bon type. |
| APP-02 | Les outils liés à une vue déclarent la ressource dans leurs métadonnées (`_meta.ui.resourceUri`) ; leur réponse texte reste complète et lisible seule (repli). | Test : réponse texte non vide et autosuffisante. |
| APP-03 | Le pont client ↔ vue suit le protocole de l'extension (initialisation, réception du résultat de l'outil, appel d'outils depuis la vue), implémenté sans dépendance réseau dans la page. | Test du script de pont avec un hôte simulé. |
| APP-04 | Les outils appelables seulement depuis une vue sont marqués visibles « app » et refusés s'ils sont appelés sans contexte de vue lorsque le client ne déclare pas l'extension (repli : le lien signé de la phase 1 reste la voie de validation). | Test : refus hors vue. |

## 4. Exigences — Vues

| ID | Exigence | Critères d'acceptation |
|---|---|---|
| APP-10 | **État du hub** : outil `kebab_status` (lecture). Vue : profil actif du jeton, nombre de skills visibles, 5 notes récentes, connecteurs actifs, compteurs de la semaine. Repli texte : le même contenu en Markdown. | Test ; capture de la vue dans un hôte simulé. |
| APP-11 | **Validation d'un envoi** : l'aperçu renvoyé par les outils d'écriture (phase 1, TRU-04) est lié à la vue `approve` ; la vue montre destinataire, compte et texte exact, avec « Valider » et « Refuser ». Ces boutons appellent `approval_decide` (visibilité « app », `destructive: true`), qui marque le `preview_id` validé ou refusé. Le lien signé reste disponible dans la réponse texte. | Tests : décision enregistrée ; le modèle ne voit pas `approval_decide` dans `tools/list`. |
| APP-12 | **Galerie de skills** : outil `skills_gallery` (lecture). Vue : skills visibles par tag, recherche, description, bouton « Charger » qui appelle `skill_load`. Templates de rituels non installés proposés avec « Installer » (`skill_template_install`, phase 1). | Test ; capture. |

## 5. Exigences — Récap hebdomadaire

| ID | Exigence | Critères d'acceptation |
|---|---|---|
| RCP-01 | Outil `kebab_weekly_recap` (lecture) : semaine demandée (défaut : la dernière complète), appels, skills les plus utilisés, clients, notes ajoutées, comparaison avec la semaine précédente, notes créées pendant la semaine (titres). Basé sur les compteurs de la phase 0 et l'index du vault. | Tests. |
| RCP-02 | Le template `weekly-review` (phase 0) appelle `kebab_weekly_recap` quand il est disponible. | Test du template. |
| RCP-03 | Carte « Récap » dans le dashboard (vue des 8 dernières semaines). | Capture. |

## 6. Exigences — Landing

| ID | Exigence | Critères d'acceptation |
|---|---|---|
| LND-01 | Sections : promesse et tagline ; « les ingrédients » (skills, profil, mémoire, outils, garde-fous) ; « mange-le partout » (matrice honnête des clients) ; « chez toi » (données, export, open source) ; « garde-fous » (contenu signalé, envois validés) ; installation (Deploy Button, Docker). Le compteur d'outils n'est plus un argument principal. | Captures desktop et mobile ; aucun lien mort (test). |
| LND-02 | Une page de documentation par rituel template, et une page « Brancher tes clients ». | Revue. |

## 7. Plan de livraison et vérification

1. Deux PR : (a) socle MCP Apps + vues + récap, (b) landing et documentation.
2. Avant chaque PR : typecheck, lint, `npm test`, build.
3. Vérifications : tests du pont avec un hôte simulé ; captures des vues rendues dans une page hôte de test ; appels MCP réels (`kebab_status`, `skills_gallery`, `kebab_weekly_recap`) sur une instance locale.
4. Après merge : vérification de la production (landing, `/api/health`).

## 8. Risques et arbitrages

- **Support inégal des clients** : le repli texte est une exigence, pas une option.
- **Visibilité « app » encore jeune** : si un client l'ignore, `approval_decide` pourrait apparaître au modèle ; APP-04 le refuse alors hors vue, et la validation par lien signé reste la voie de référence.
- **CSP des vues** : HTML autonome sans ressource externe, pour rester compatible avec les politiques des hôtes.
