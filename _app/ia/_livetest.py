# Test du chemin de conversion LIVE (infer_block) avec un vrai bloc audio.
# Reproduit exactement ce que fait la boucle temps réel, hors capture micro.
import sys, time, traceback
from pathlib import Path

import numpy as np
import torch
import torchaudio

import server  # le vrai backend (n'exécute pas uvicorn hors __main__)

def main():
    print("== État ==")
    print("device:", server.DEVICE)
    models = server.find_models()
    print("modèles:", [m["name"] for m in models])
    if not any(m["name"] == "EmmanuelMacron" for m in models):
        print("FAIL: modèle EmmanuelMacron introuvable")
        return 1

    print("== Chargement du modèle ==")
    t0 = time.time()
    server.load_model("EmmanuelMacron")
    print(f"chargé en {time.time()-t0:.1f}s, tgt_sr={server.S.target_sr}")

    # Bloc audio réel : un son avec de la voix, converti en 16k mono float32
    src = Path(__file__).resolve().parents[2] / "macron-for-sure.mp3"
    print("== Audio source:", src.name, "==")
    wav, sr = torchaudio.load(str(src))
    wav = wav.mean(dim=0, keepdim=True)
    wav = torchaudio.functional.resample(wav, sr, 16000)
    audio = wav.squeeze(0).numpy().astype(np.float32)
    print(f"audio 16k: {len(audio)} échantillons ({len(audio)/16000:.2f}s)")

    # Mêmes dimensions que le live : bloc 0.35s + 2x0.08s de contexte
    seg_len = int((0.35 + 2 * 0.08) * 16000)
    seg = audio[: seg_len]
    if len(seg) < seg_len:
        seg = np.pad(seg, (0, seg_len - len(seg)))
    print(f"segment: {len(seg)} échantillons, rms_in={float(np.sqrt(np.mean(seg**2))):.4f}")

    print("== infer_block (2 passes : la 1re charge HuBERT) ==")
    for i in range(2):
        t0 = time.time()
        try:
            out = server.infer_block(seg)
        except Exception:
            print("FAIL: exception dans infer_block :")
            traceback.print_exc()
            return 1
        dt = time.time() - t0
        out = np.asarray(out, dtype=np.float32).flatten()
        rms = float(np.sqrt(np.mean(out ** 2))) if len(out) else 0.0
        ratio = server.S.target_sr / 16000
        expected = int(len(seg) * ratio)
        print(f"passe {i+1}: {dt*1000:.0f} ms, sortie={len(out)} éch. (attendu ~{expected}), "
              f"dtype={out.dtype}, rms_out={rms:.4f}")
        if not len(out):
            print("FAIL: sortie vide")
            return 1
        if rms < 1e-4:
            print("FAIL: sortie silencieuse (rms ~ 0)")
            return 1

    # Découpe du contexte + crossfade comme dans live_loop
    ratio = server.S.target_sr / 16000
    cut = int(int(0.08 * 16000) * ratio)
    core = out[cut: len(out) - cut]
    print(f"après découpe contexte: {len(core)} éch., rms={float(np.sqrt(np.mean(core**2))):.4f}")
    if not len(core):
        print("FAIL: bloc central vide après découpe")
        return 1

    # Simule l'écriture moniteur (dtype check de sounddevice)
    mon = core * float(0.7)
    print(f"dtype écriture moniteur: {mon.dtype} (doit être float32)")
    if mon.dtype != np.float32:
        print("FAIL: dtype moniteur invalide pour sounddevice")
        return 1

    # ---- Simulation complète de live_loop (blocs + normalisation + crossfade) ----
    print("== Simulation du live complet sur tout le fichier ==")
    out_sr = server.S.target_sr
    mic_sr = 16000
    block = int(0.35 * mic_sr)
    extra = int(0.08 * mic_sr)
    xf = int(0.06 * out_sr)
    ratio = out_sr / mic_sr

    in_buffer = audio.copy()
    prev_tail = np.zeros(xf, dtype=np.float32)
    pieces = []
    t0 = time.time()
    n_blocks = 0
    while len(in_buffer) >= block + 2 * extra:
        seg2 = in_buffer[: block + 2 * extra]
        in_buffer = in_buffer[block:]
        out2 = np.asarray(server.infer_block(seg2), dtype=np.float32).flatten()
        # normalisation identique au correctif de live_loop
        if len(out2) and float(np.max(np.abs(out2))) > 2.0:
            out2 = out2 / 32768.0
        np.clip(out2, -1.0, 1.0, out=out2)
        cut2 = int(extra * ratio)
        core2 = out2[cut2: len(out2) - cut2] if len(out2) > 2 * cut2 else out2
        if xf > 0 and len(core2) > xf:
            fade_in = np.linspace(0, 1, xf, dtype=np.float32)
            core2[:xf] = core2[:xf] * fade_in + prev_tail * (1 - fade_in)
            prev_tail = core2[-xf:].copy()
            pieces.append(core2[:-xf])
        else:
            pieces.append(core2)
        n_blocks += 1
    total = np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.float32)
    dt = time.time() - t0
    dur_in = len(audio) / mic_sr
    dur_out = len(total) / out_sr
    peak = float(np.max(np.abs(total))) if len(total) else 0.0
    rms = float(np.sqrt(np.mean(total ** 2))) if len(total) else 0.0
    print(f"{n_blocks} blocs en {dt:.1f}s (audio de {dur_in:.2f}s) -> "
          f"x{dur_in/dt:.1f} temps réel")
    print(f"sortie: {dur_out:.2f}s, peak={peak:.3f} (doit être <= 1), rms={rms:.4f}")
    if peak > 1.001 or rms < 0.005:
        print("FAIL: signal de sortie anormal")
        return 1

    # WAV écoutable pour vérification humaine
    from scipy.io import wavfile
    out_path = Path(__file__).parent / "_livetest_out.wav"
    wavfile.write(str(out_path), out_sr, (total * 32767).astype(np.int16))
    print("WAV écrit:", out_path)

    print("PASS: la conversion live fonctionne de bout en bout")
    return 0

sys.exit(main())
