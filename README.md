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
- **Ajout facile** : glisser-déposer, bouton « ➕ Ajouter des sons », import depuis une **URL**, ou copie dans le dossier
- **Icônes personnalisables** : clic droit → « 🎨 Changer l'icône » → emoji, couleur, ou **ta propre image**
- **Catégories** (sous-dossiers) avec glisser-déposer d'une tuile vers une catégorie
- **Favoris** (⭐), **recherche**, **son au hasard** (🎲), sections « ⭐ Favoris » et « 🔥 Les plus joués »
- **Tris** : par nom, par plus joués, par récents · **Vues** : grandes tuiles / compact / liste
- **Volume par son** (molette), **écoute privée** (Shift+clic, casque seulement), fondu anti-« clac »
- **Éditeur audio** intégré (clic droit → ✂️ Éditer) : découpe avec waveform, fondus, aperçu
- **Normalisation du volume** : à l'import, par son, ou **toute la bibliothèque d'un coup** (loudnorm EBU R128)
- **Renommer / supprimer** au clic droit (suppressions vers une corbeille, rien n'est perdu)
- **Double sortie** : vers Discord + retour dans ton casque · **ducking** auto (ta voix baisse pendant un son)

### 🎙️ Onglet « Voix » (modulateur temps réel)
- **24+ voix** prêtes à l'emploi appliquées en direct (grave, aigüe, robot, radio, cathédrale, vador, hélium,
  sous-l'eau, mégaphone, chorale, sorcière, géant, vinyle, militaire…)
- **Pad XY** pour piloter en continu la hauteur (pitch) et le timbre (formants)
- **Presets personnels** : sauvegarde tes combinaisons voix + pad pour les rejouer
- **🎧 M'entendre parler** : retour casque de ta voix transformée, avec sélecteur de périphérique + test
- **Voix IA (RVC / VCClient)** : conversion de ta voix vers une autre personne, en temps réel (optionnel, GPU)
- Tu peux **parler avec une voix modifiée ET jouer des sons en même temps**

### 🗣️ Onglet « Dire » (TTS)
- **Texte → voix** dit dans Discord (synthèse vocale), avec choix de voix, débit, hauteur
- Option **texte → voix IA** : la synthèse est convertie avec une voix RVC
- Historique, favoris, et « garder » un TTS comme son du soundboard

### ⏺ Onglet « Replay » (façon ShadowPlay)
- **Instant replay audio** : garde en mémoire les dernières secondes (micro ou son du PC), fige-les en un son
- **Replay vidéo** : capture d'écran en tampon circulaire (15 s à 3 min), sauvegarde de clips `.webm`
- **Détection de moments forts** + auto-clip · reconnaissance de sons **YAMNet** (bêta)
- **Live looper** : capture une boucle courte et rejoue-la à la volée (raccourcis dédiés)

### 🛡️ Micro & confort
- **Réduction de bruit IA (RNNoise, technique de Krisp)** : supprime clavier, ventilo, etc. — pas les sons
- **Raccourcis clavier globaux** : marchent **même en jeu / fenêtre non focus**, tous réattribuables depuis le Guide
- **Overlay in-game** : mini-fenêtre de favoris toujours au-dessus du jeu
- **Profils multiples** : plusieurs bibliothèques séparées (JDR, stream, entre potes…)
- **Thèmes de couleur** + **10 fonds d'écran** (hexagones, arcade, aurora, circuit, matrix, vagues, étoiles…)
- **Export / import** de la bibliothèque (`.soundboard`) pour la partager ou la transférer

### 🖥️ Application native
- Se réduit dans la **zone de notification** (continue de tourner en fond) · option **« Démarrer avec Windows »**
- **Dossier des sons configurable** + détection automatique des ajouts/retraits

---

## 🚀 Installation & lancement

### Option A — Utiliser l'exécutable prêt à l'emploi
1. Récupère **`Soundboard Discord.exe`** (construis-le — voir plus bas)
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

> L'application détecte automatiquement l'absence du câble et propose un assistant d'installation au démarrage.

### 2. Configurer le Soundboard (réglages ⚙️)
| Réglage | Valeur | Rôle |
|---|---|---|
| 📡 **Sortie vers Discord** | `CABLE Input` | verse les sons dans le tuyau |
| 🎤 **Mon micro → Discord** | activé, ton micro `HyperX` | verse ta voix dans le même tuyau |
| 🔊 **Écouter les sons dans mon casque** | ton casque `HyperX` | pour t'entendre jouer les sons |

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
| Écouter en privé (toi seul) | Shift + clic |
| Volume d'un son | Molette sur la tuile |
| Tout arrêter | Bouton ⏹ ou touche `Échap` (global : `Ctrl+Alt+X`) |
| Assigner / changer une touche | Clic droit → « Assigner une touche », ou onglet **Guide** |
| Éditer (découper) | Clic droit → ✂️ Éditer |
| Normaliser tout | Réglages ⚙️ → « 📊 Normaliser tous les sons existants » |
| Changer l'icône | Clic droit → « 🎨 Changer l'icône » |
| Modifier sa voix | Onglet « 🎙️ Voix » → clic sur une voix (+ pad XY) |
| S'entendre transformé | Onglet Voix → « 🎧 M'entendre parler » |

> 💡 Idées de sons : [myinstants.com](https://www.myinstants.com). Organise en catégories via des sous-dossiers.
> L'onglet **📖 Guide** liste tous les raccourcis et permet de les réattribuer.

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
- `signAndEditExecutable: false` évite l'étape `rcedit`. L'icône du `.exe` reste celle d'Electron
  par défaut, mais l'icône **de la fenêtre et du tray** est bien celle de l'app.
- Versions figées : **Electron 37 + electron-builder 24**.
- La **capture d'écran** (replay) utilise le capteur legacy (DXGI/GDI) plutôt que Windows Graphics
  Capture, pour éviter le spam d'erreurs `ProcessFrame failed` en console.
</details>

---

## 🧱 Architecture du code

```
_app/
├── main.js               # Processus principal : fenêtre, tray, raccourcis globaux,
│                         #   accès fichiers, protocoles snd:// icon:// vid://, ffmpeg, profils
├── preload.js            # Pont sécurisé (contextBridge) entre l'UI et le main
├── renderer/
│   ├── index.html        # Structure de l'interface (5 onglets + réglages)
│   ├── style.css         # Thème (inspiré de Discord) + thèmes de couleur + fonds d'écran
│   ├── renderer.js       # Logique UI : lecture, upload, voix, replay, TTS, réglages…
│   ├── voicefx.js        # Moteur de modulation de voix (presets + effets Web Audio)
│   └── overlay.html/.js  # Mini-fenêtre overlay in-game (favoris)
├── vendor/               # SoundTouchJS (pitch), RNNoise (débruitage), ORT + YAMNet (reco sons)
├── ia/                   # Backend Python optionnel (voix IA RVC) : server.py, setup.ps1
└── build/                # Icônes de l'application
```

**Points techniques :**
- Les fichiers audio, images et vidéos sont servis via des **protocoles personnalisés**
  (`snd://`, `icon://`, `vid://`) avec support des requêtes Range et protection anti-traversal.
- La modulation de voix insère une chaîne d'effets Web Audio (+ pitch en AudioWorklet) dans le
  trajet micro → câble. Le débruitage RNNoise tourne dans un AudioWorklet dédié à la chaîne micro.
- Réglages et personnalisations (icônes, raccourcis, favoris, voix, thème…) sont persistés localement
  dans un `state.json` par profil (écriture atomique).

---

## 📄 Licence

Code du projet sous licence **MIT**.
Inclut [SoundTouchJS](https://github.com/cutterjs/soundtouchjs) (MPL-2.0) et
[@jitsi/rnnoise-wasm](https://github.com/jitsi/rnnoise-wasm) dans `_app/vendor/`.
Nécessite [VB-Audio Virtual Cable](https://vb-audio.com/Cable/) (gratuit, installé séparément).
La voix IA optionnelle s'appuie sur [VCClient](https://github.com/w-okada/voice-changer) (w-okada).
