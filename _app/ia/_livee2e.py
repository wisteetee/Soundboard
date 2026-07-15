# Test de bout en bout du LIVE : capture -> conversion -> sortie, sans micro humain.
# Astuce : on joue un son de voix dans « CABLE Input » ; le live capture depuis
# « CABLE Output » (l'autre bout du câble) comme si c'était un micro. Les niveaux
# in_rms / rms du serveur prouvent que la chaîne complète fonctionne.
import sys
import time
from pathlib import Path

import numpy as np
import torchaudio
import sounddevice as sd

import server
from rvc_python.modules.vc.utils import load_hubert


def main():
    print("== préparation ==")
    server.load_model("EmmanuelMacron")
    vc = server.S.rvc.vc
    if getattr(vc, "hubert_model", None) is None:
        vc.hubert_model = load_hubert(vc.config, vc.lib_dir)

    cable_in_as_mic = server.find_device("CABLE Output", want_output=False)
    cable_playback = server.find_device("CABLE Input", want_output=True)
    print("capture (CABLE Output) idx:", cable_in_as_mic, "| lecture (CABLE Input) idx:", cable_playback)
    if cable_in_as_mic is None or cable_playback is None:
        print("FAIL: câble virtuel introuvable")
        return 1

    print("== démarrage du live (entrée = câble, sortie = périphérique par défaut) ==")
    r = server.live_start({
        "input_device": "CABLE Output",
        "output_device": None,       # sortie par défaut (tu entendras ~3s de Macron !)
        "monitor": False,
        "f0up_key": 0,
        "live_index_rate": 0,
    })
    print("live_start:", r if isinstance(r, dict) else "erreur")
    if not (isinstance(r, dict) and r.get("ok")):
        return 1

    # espionne chaque appel de conversion pour voir entrée/sortie par bloc
    orig_infer = server.infer_block
    blocks = []
    def spy(seg):
        out = orig_infer(seg)
        a = np.asarray(out, dtype=np.float32)
        blocks.append({
            "in_rms": round(float(np.sqrt(np.mean(seg ** 2))), 5),
            "out_max": round(float(np.abs(a).max()) if len(a) else 0.0, 1),
            "out_len": int(len(a)),
        })
        return out
    server.infer_block = spy

    print("== injection d'un son de voix dans le câble (amplifié x3) ==")
    wav, sr = torchaudio.load(str(Path(__file__).resolve().parents[2] / "macron-for-sure.mp3"))
    data = wav.mean(dim=0).numpy().astype(np.float32)
    data = np.clip(data * 3.0, -0.95, 0.95)
    data = np.tile(data, 4)  # ~4 s
    sd.play(data, sr, device=cable_playback)

    levels = []
    for _ in range(14):
        time.sleep(0.3)
        levels.append((round(server.S.in_rms, 5), round(server.S.rms, 5)))
    sd.stop()
    server.live_stop()
    time.sleep(0.6)
    print("blocs convertis :", len(blocks))
    for b in blocks[:10]:
        print("  ", b)

    print("niveaux (entrée, sortie) toutes les 0.3s :")
    for l in levels:
        print("  ", l)
    max_in = max(l[0] for l in levels)
    max_out = max(l[1] for l in levels)
    print(f"max entrée: {max_in} | max sortie: {max_out}")

    if max_in < 0.005:
        print("FAIL: le live n'entend rien (capture morte)")
        return 1
    if len(blocks) < 6:
        print(f"FAIL: seulement {len(blocks)} blocs convertis en ~4s (pas temps réel)")
        return 1
    if max_out < 0.01:
        print("FAIL: aucun son converti produit")
        return 1
    print("PASS: chaîne live complète opérationnelle (capture -> IA -> sortie)")
    return 0


sys.exit(main())
