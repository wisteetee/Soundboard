# Reconstruire l'application (.exe)

Ce dossier `_app/` contient le code source de l'application Windows (Electron).
Le dossier commence par `_` : il est **ignoré** par le scan des sons du soundboard.

## Prérequis
- Node.js (déjà installé sur cette machine)

## Étapes

```bash
cd "_app"
npm install
npm run dist
```

Le `.exe` portable est généré dans `_app/dist/Soundboard-Discord-Portable-1.0.0.exe`.
Copie-le à la racine du dossier (renommé `Soundboard Discord.exe`) pour l'utiliser.

## Lancer en mode développement (sans builder)

```bash
cd "_app"
npm start
```

## Notes techniques

- **Cible de build : `portable`** (un seul `.exe` autonome, aucune installation).
  Choisi car la cible `nsis` (installateur classique) échoue sur cette machine :
  electron-builder tente d'extraire des liens symboliques macOS du cache `winCodeSign`,
  ce que Windows interdit sans Mode développeur / droits admin.
- `signAndEditExecutable: false` dans `package.json` évite l'étape `rcedit`
  (qui dépend aussi de ce cache). Conséquence : l'icône du `.exe` reste l'icône
  Electron par défaut, mais l'icône **de la fenêtre et de la zone de notification**
  est bien la nôtre (`build/icon.ico`).
- Versions figées volontairement : **Electron 37 + electron-builder 24**, car les
  versions plus récentes (`@electron/get` en ESM) sont incompatibles avec la version
  de Node de cette machine (20.12).

## Pour obtenir un vrai installateur .exe (NSIS) plus tard

Active le **Mode développeur Windows** (Paramètres → Confidentialité et sécurité →
Pour les développeurs → Mode développeur = Activé), puis dans `package.json` remets
`"target": "nsis"` et relance `npm run dist`. Le Mode développeur autorise la création
de liens symboliques et débloque le build de l'installateur.
