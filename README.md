# 🎙️ Soundboard Discord

Une application Windows (Electron) pour jouer des **memes vocaux** dans Discord **et** modifier ta voix
en temps réel (type Voicemod), le tout envoyé à tes amis à travers un micro virtuel.

![Windows](https://img.shields.io/badge/Windows-10%2F11-0078D6?logo=windows)
![Electron](https://img.shields.io/badge/Electron-37-47848F?logo=electron)
![License](https://img.shields.io/badge/licence-MIT-green)

---

## ✨ Fonctionnalités

### 🎵 Onglet « Sons »
- **Grille de sons** cliquables (MP3, WAV, OGG, M4A, FLAC, WEBM, AAC, OPUS)
- **Ajout facile** : glisser-déposer sur la fenêtre, bouton « ➕ Ajouter des sons », ou copie directe dans le dossier
- **Icônes personnalisables** : clic droit → « 🎨 Changer l'icône » → emoji, couleur, ou **ta propre image**
- **Raccourcis clavier globaux** : assigne une touche (ex. `Ctrl+Alt+1`) qui marche **même en jeu ou fenêtre non focus**
- **Favoris** (⭐), **recherche**, **son au hasard** (🎲), **catégories** (via sous-dossiers)
- **Renommer / supprimer** au clic droit (les suppressions vont dans une corbeille, rien n'est perdu)
- **Double sortie** : volume vers Discord + retour dans ton casque pour t'entendre

### 🎙️ Onglet « Voix » (modulateur temps réel)
14 voix prêtes à l'emploi, appliquées en direct pendant que tu parles :

| | | | |
|---|---|---|---|
| 🎤 Normale | 👹 Grave / Monstre | 😈 Démon | 🐿️ Aigüe / Écureuil |
| 🧒 Enfant | 🤖 Robot | 🦾 Cyborg | ⛪ Cathédrale |
| 🕳️ Grotte / Écho | 📻 Radio | 📞 Téléphone | 🔊 Talkie-walkie |
| 👽 Alien | 👻 Fantôme | | |

- **Pitch** (grave/aigu) via [SoundTouchJS](https://github.com/cutterjs/soundtouchjs) dans un AudioWorklet
- **Effets** (robot, réverb, écho, radio, téléphone, distorsion, trémolo) en Web Audio natif
- **🎧 Retour casque** pour t'entendre transformé et régler tes effets
- Tu peux **parler avec une voix modifiée ET jouer des sons en même temps**

### 🖥️ Application native
- Se réduit dans la **zone de notification** (continue de tourner en fond)
- Option **« Démarrer avec Windows »**
- **Dossier des sons configurable** + détection automatique des ajouts/retraits

---

## 🚀 Installation & lancement

### Option A — Utiliser l'exécutable prêt à l'emploi
1. Récupère **`Soundboard Discord.exe`** (à la racine de ce repo, ou construis-le — voir plus bas)
2. Double-clique dessus. C'est un `.exe` **portable** : rien à installer, il fonctionne tel quel.

### Option B — Lancer depuis le code source
```bash
cd _app
npm install
npm start
```

---

## 🔌 Comprendre le routage audio (important !)

Discord ne peut écouter **qu'un seul micro** à la fois. Pour lui envoyer à la fois ta voix
**et** les sons, on les mélange tous les deux dans un **câble audio virtuel**, et Discord écoute
la sortie de ce câble.

```
🎧 Micro HyperX ─┐
                 ├──> 🔌 CABLE Input ──(câble)──> 🔊 CABLE Output ──> 💬 Discord ──> 👥 Amis
🎙️ Soundboard ──┘        (le « micro virtuel »)      (ce que Discord écoute)
```

### 1. Installer le câble virtuel (une seule fois)
1. Télécharge **[VB-Audio Virtual Cable](https://vb-audio.com/Cable/)** (gratuit)
2. Dézippe, clic droit sur `VBCABLE_Setup_x64.exe` → **Exécuter en tant qu'administrateur** → *Install Driver*
3. **Redémarre le PC**

### 2. Configurer le Soundboard (réglages ⚙️)
| Réglage | Valeur | Rôle |
|---|---|---|
| 📡 **Sortie vers Discord** | `CABLE Input` | verse les sons dans le tuyau |
| 🎤 **Mon micro → Discord** | activé, ton micro `HyperX` | verse ta voix dans le même tuyau |
| 🎧 **Retour local** | ton casque `HyperX` | pour t'entendre jouer les sons |

### 3. Configurer Discord (⚙️ → Voix et vidéo)
1. **Périphérique d'entrée** → `CABLE Output (VB-Audio Virtual Cable)`
2. **Périphérique de sortie** → ton casque (inchangé)
3. ⚠️ **Désactive la Suppression du bruit (Krisp)** — sinon Discord filtre les memes comme du bruit
4. **Sensibilité d'entrée** → décoche « automatique », curseur assez bas

---

## ⌨️ Aide-mémoire

| Action | Comment |
|---|---|
| Jouer un son | Clic sur la tuile |
| Tout arrêter | Bouton ⏹ ou touche `Échap` (global : `Ctrl+Alt+X`) |
| Assigner une touche | Clic droit → « Assigner une touche » |
| Changer l'icône | Clic droit → « 🎨 Changer l'icône » |
| Renommer / Supprimer | Clic droit |
| Favori | ⭐ en haut à gauche de la tuile |
| Son au hasard | 🎲 |
| Modifier sa voix | Onglet « 🎙️ Voix » → clic sur une voix |
| S'entendre transformé | Onglet Voix → « 🎧 M'entendre » |

> 💡 Idées de sons : [myinstants.com](https://www.myinstants.com) (bouton télécharger sous chaque son).
> Crée des sous-dossiers dans le dossier des sons pour organiser par catégories.

---

## 🛠️ Construire l'exécutable soi-même

```bash
cd _app
npm install
npm run dist
```
Le `.exe` portable est généré dans `_app/dist/`.

<details>
<summary>Notes techniques sur le build (à lire en cas de souci)</summary>

- **Cible `portable`** (un seul `.exe` autonome). La cible `nsis` (installateur classique)
  échoue sur certaines machines Windows : electron-builder tente d'extraire des liens
  symboliques macOS du cache `winCodeSign`, interdit sans **Mode développeur** / droits admin.
  Pour un vrai installateur : active le Mode développeur Windows puis remets `"target": "nsis"`.
- `signAndEditExecutable: false` évite l'étape `rcedit` (qui dépend du même cache). L'icône
  du fichier `.exe` reste celle d'Electron par défaut, mais l'icône **de la fenêtre et du tray**
  est bien celle de l'app.
- Versions figées : **Electron 37 + electron-builder 24** (les versions plus récentes utilisent
  `@electron/get` en ESM, incompatible avec certaines versions de Node).
</details>

---

## 🧱 Architecture du code

```
_app/
├── main.js               # Processus principal Electron : fenêtre, tray, raccourcis
│                         #   globaux, accès fichiers, protocoles snd:// et icon://
├── preload.js            # Pont sécurisé (contextBridge) entre l'UI et le main
├── renderer/
│   ├── index.html        # Structure de l'interface (onglets Sons / Voix, réglages)
│   ├── style.css         # Thème (inspiré de Discord)
│   ├── renderer.js       # Logique UI : lecture, upload, icônes, raccourcis, réglages
│   └── voicefx.js        # Moteur de modulation de voix (presets + effets Web Audio)
├── vendor/               # SoundTouchJS (pitch-shift, embarqué localement — hors-ligne)
└── build/                # Icônes de l'application
```

**Points techniques :**
- Les fichiers audio et images sont servis à l'interface via des **protocoles personnalisés**
  (`snd://` et `icon://`) avec protection contre l'accès hors dossier.
- La modulation de voix insère une chaîne d'effets Web Audio dans le trajet micro → câble.
- Les réglages et personnalisations (icônes, raccourcis, favoris, voix) sont persistés en local.

---

## 📄 Licence

Code du projet sous licence **MIT**.
Inclut [SoundTouchJS](https://github.com/cutterjs/soundtouchjs) (MPL-2.0) dans `_app/vendor/`.
Nécessite [VB-Audio Virtual Cable](https://vb-audio.com/Cable/) (gratuit, installé séparément).
