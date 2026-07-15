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
- **Favoris** (⭐), **recherche**, **son au hasard** (🎲), section **🔥 Les plus joués**
- **Catégories complètes** : créer/renommer/supprimer (📁➕), **drag & drop** entre catégories, repliables d'un clic
- **Volume par son** : molette de la souris sur une tuile
- **🎧 Écoute privée** : Shift+clic joue le son dans ton casque **sans** l'envoyer à Discord
- **Tri** : nom / plus joués / récents · **Import depuis une URL** (🌐, lien direct .mp3)
- **✂️ Éditeur de découpe** : clic droit → « Éditer / Découper » → forme d'onde, poignées de début/fin, fondus, aperçu. Remplace le son ou crée une copie (découpe MP3 précise via ffmpeg, téléchargé une seule fois)
- **Renommer / supprimer** au clic droit (les suppressions vont dans une corbeille, rien n'est perdu)
- **Double sortie** : volume vers Discord + retour dans ton casque, **fondu** propre sur Stop

### 🎙️ Onglet « Voix » (modulateur temps réel)
14 voix prêtes à l'emploi, appliquées en direct pendant que tu parles :

| | | | |
|---|---|---|---|
| 🎤 Normale | 👹 Grave / Monstre | 😈 Démon | 🐿️ Aigüe / Écureuil |
| 🧒 Enfant | 🤖 Robot | 🦾 Cyborg | ⛪ Cathédrale |
| 🕳️ Grotte / Écho | 📻 Radio | 📞 Téléphone | 🔊 Talkie-walkie |
| 👽 Alien | 👻 Fantôme | | |

L'onglet Voix est découpé en deux sections :

**🎛️ Modification voix** — effets audio instantanés, sans installation :
- **Pitch** (grave/aigu) via [SoundTouchJS](https://github.com/cutterjs/soundtouchjs) dans un AudioWorklet
- **Effets** (robot, réverb, écho, radio, téléphone, distorsion, trémolo) en Web Audio natif
- **🎧 Retour casque** pour t'entendre transformé et régler tes effets
- Tu peux **parler avec une voix modifiée ET jouer des sons en même temps**

**🧠 IA personnalités** — conversion de voix par IA (RVC), en temps réel :
- Transforme ta voix en **une autre personne** (ex. Emmanuel Macron) pendant que tu parles
- Basé sur des modèles **RVC** (`.pth` + `.index`) placés dans le dossier `Voix IA/<NomDuModèle>/`
- Réglages **tonalité** (demi-tons) et **ressemblance** (index), en direct
- Nécessite un **backend Python + GPU** (voir « Installer la voix IA » ci-dessous)
- ⚠️ Latence ~0,3–0,5 s (inhérente au RVC temps réel). Le live IA prend le micro et
  désactive automatiquement les effets classiques.

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

**Le plus simple :** au premier lancement, si le câble est absent, l'app propose un
**assistant en 1 clic** (« ⚡ Installer le câble audio »). Elle télécharge et installe
VB-Cable pour toi — accepte simplement la fenêtre d'autorisation Windows (administrateur),
puis **redémarre le PC** quand elle te le propose.

<details>
<summary>Installation manuelle (si tu préfères)</summary>

1. Télécharge **[VB-Audio Virtual Cable](https://vb-audio.com/Cable/)** (gratuit)
2. Dézippe, clic droit sur `VBCABLE_Setup_x64.exe` → **Exécuter en tant qu'administrateur** → *Install Driver*
3. **Redémarre le PC**
</details>

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

## 🧠 Installer la voix IA (RVC) — optionnel

La section **« IA personnalités »** de l'onglet Voix a besoin d'un moteur Python (PyTorch + RVC).
C'est **optionnel** : le reste de l'app fonctionne sans. Prévois un **GPU NVIDIA** et plusieurs Go d'espace.

### Installation (une seule fois)
1. Ouvre l'onglet **🎙️ Voix** → section **🧠 IA personnalités** → **« 📥 Installer la voix IA »**.
2. L'app installe automatiquement un **Python 3.10 dédié**, **PyTorch CUDA**, et **rvc-python**
   (~3–4 Go). La progression s'affiche dans le journal. Au **premier live**, les modèles
   auxiliaires (HuBERT, RMVPE) se téléchargent aussi (quelques centaines de Mo).

> Le backend s'installe dans un environnement isolé et ne pollue pas ton Python système.
> Il n'est lancé **qu'à la demande** (pas au démarrage de l'app).

### Ajouter une voix (modèle RVC)
Place un modèle dans `Voix IA/<NomDeLaVoix>/` avec un fichier `.pth` (le modèle) et,
idéalement, un `.index` (améliore le timbre). Exemple fourni : `Voix IA/EmmanuelMacron/`.
Les voix disponibles apparaissent comme des cartes dans la section IA.

### Utiliser le live IA
1. Vérifie que **CABLE Input** est bien choisi dans « Sortie vers Discord » (⚙️).
2. Sélectionne une personnalité, règle la **tonalité** si besoin, puis **« ▶️ Démarrer le live IA »**.
3. Parle : ta voix convertie part dans le câble virtuel → Discord. Pour t'écouter, active
   « 🎧 M'entendre » (retour casque).

> 💡 Réglages : garde la **ressemblance (index) basse (0–0.3)** pour un direct fluide —
> l'index haut améliore le timbre mais ajoute beaucoup de latence. La **tonalité** compense
> l'écart entre ta voix et la cible (ex. voix grave → cible plus aiguë = monter de quelques demi-tons).

---

## ⌨️ Aide-mémoire

| Action | Comment |
|---|---|
| Jouer un son | Clic sur la tuile |
| Tout arrêter | Bouton ⏹ ou touche `Échap` (global : `Ctrl+Alt+X`) |
| Assigner une touche | Clic droit → « Assigner une touche » |
| Changer l'icône | Clic droit → « 🎨 Changer l'icône » |
| Découper / raccourcir un son | Clic droit → « ✂️ Éditer / Découper » |
| Renommer / Supprimer | Clic droit |
| Favori | ⭐ en haut à gauche de la tuile |
| Écoute privée (sans Discord) | `Shift+clic` sur la tuile |
| Volume individuel d'un son | Molette de la souris sur la tuile |
| Replier une catégorie | Clic sur son en-tête |
| Déplacer un son de catégorie | Glisser-déposer la tuile |
| Importer depuis une URL | 🌐 puis coller un lien direct .mp3 |
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
