# Reprise du projet sur une nouvelle machine

Guide court pour repartir de zéro (ex. PC portable) après un `git clone`.

## 1. Cloner le dépôt

```bash
git clone https://github.com/wisteetee/Soundboard.git
cd Soundboard
```

## 2. Installer les dépendances de l'app

Le code Electron vit dans `_app/`. Les dépendances (`node_modules/`) ne sont **pas**
versionnées — on les réinstalle :

```bash
cd _app
npm install
```

Prérequis : **Node.js 18+** (Node 20 recommandé) installé sur la machine.

## 3. Lancer l'app

- **En développement** (rechargement rapide, depuis les sources) :
  ```bash
  npm start
  ```
- **Construire le .exe portable** (Windows) :
  ```bash
  npm run dist
  ```
  Le portable est généré dans `_app/dist/Soundboard-Discord-Portable-1.0.0.exe`.
  On le copie ensuite à la racine sous le nom `Soundboard Discord.exe`.

  Note build : electron-builder est lancé avec `CSC_IDENTITY_AUTO_DISCOVERY=false`
  pour éviter le souci de signature/winCodeSign. Le `.exe` racine est versionné,
  donc il est déjà prêt à l'emploi juste après le clone (sans rebuild).

## 4. Ce qui se (re)télécharge tout seul sur la nouvelle machine

Ces composants ne sont pas dans le dépôt (trop lourds) et se retéléchargent à la
demande dans le dossier `userData` de l'app au premier usage :

| Composant            | Taille  | Déclencheur                                   |
|----------------------|---------|-----------------------------------------------|
| **ffmpeg**           | ~80 Mo  | 1re découpe/normalisation dans l'éditeur audio |
| **YAMNet (ONNX)**    | ~16 Mo  | Bouton « Activer la reconnaissance » (Replay bêta) |
| **VCClient (CUDA)**  | ~3,5 Go | Bouton « Installer le moteur de voix IA » (onglet Voix) |

`userData` = `%APPDATA%\Soundboard Discord\` sous Windows.

## 5. Ce qui n'est PAS dans le dépôt (à recopier manuellement si besoin)

- **Ta bibliothèque de sons perso** (`*.mp3` et catégories à la racine) — ignorée par
  `.gitignore`. Utilise plutôt la fonction **Réglages → Exporter** (fichier `.soundboard`)
  pour transférer sons + icônes + réglages entre machines.
- Les **modèles de voix IA** (`Voix IA/`, `.pth`/`.index`).
- Les environnements lourds (`_app/node_modules/`, `_app/dist/`, venv Python).

## Structure

```
_app/                  Code de l'application Electron
  main.js              Processus principal (IPC, protocoles snd:// icon:// vid://, backends)
  preload.js           Pont sécurisé renderer ↔ main
  renderer/            UI (index.html, renderer.js, style.css, overlay.*)
  vendor/              Assets embarqués (soundtouch, ort-web + wasm, denoise-processor, class map YAMNet)
  ia/                  Backend Python RVC hérité (server.py, setup.ps1)
Soundboard Discord.exe Build portable prêt à l'emploi (versionné)
```
