"""
Backend Voix IA (RVC) pour Soundboard Discord.

Serveur HTTP local (127.0.0.1) que l'app Electron pilote. Deux usages :
  - /convert : convertit un fichier audio en la voix cible (validation + hors-ligne).
  - /live/*  : conversion temps réel micro -> CABLE Input, par blocs avec crossfade.

Moteur : rvc-python (embarque HuBERT/RMVPE, gère .pth + .index, inférence CUDA).
Le trajet audio live est entièrement côté Python (sounddevice) : Electron ne fait
que démarrer/arrêter et lire l'état.
"""
import os
import sys
import io
import json
import base64
import threading
import traceback
from pathlib import Path

import numpy as np

# --- Dossiers ---
# Le dossier des modèles est passé en argument (--models-dir) ou déduit.
def parse_arg(flag, default=None):
    if flag in sys.argv:
        i = sys.argv.index(flag)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default

PORT = int(parse_arg("--port", os.environ.get("IA_PORT", "5273")))
# Par défaut : « <dossier des sons>/Voix IA » ; sinon relatif au repo.
DEFAULT_MODELS = str(Path(__file__).resolve().parents[2] / "Voix IA")
MODELS_DIR = Path(parse_arg("--models-dir", os.environ.get("IA_MODELS_DIR", DEFAULT_MODELS)))

import torch
import sounddevice as sd
import torchaudio
from fastapi import FastAPI, Body
from fastapi.responses import JSONResponse
import uvicorn

try:
    from rvc_python.infer import RVCInference
except Exception as e:  # pragma: no cover
    print("IA:ERREUR import rvc_python:", e, flush=True)
    raise

DEVICE = "cuda:0" if torch.cuda.is_available() else "cpu"

app = FastAPI()

# --- État global ---
class State:
    rvc = None                 # instance RVCInference
    model_name = None          # nom du modèle chargé
    target_sr = 40000          # SR de sortie du modèle (déduit au chargement)
    # paramètres de conversion
    f0up_key = 0               # transposition en demi-tons
    index_rate = 0.5
    f0method = "rmvpe"
    protect = 0.33
    filter_radius = 3
    rms_mix_rate = 0.25
    # En live, l'index FAISS coûte ~1s/appel -> on le réduit fortement pour la latence.
    live_index_rate = 0.0
    live_f0method = "rmvpe"
    # live
    live = False
    live_thread = None
    live_stop = threading.Event()
    input_device = None
    output_device = None       # câble virtuel (ou casque en mode test)
    monitor_on = False         # retour casque actif ?
    monitor_vol = 0.7
    last_error = None
    rms = 0.0                  # niveau de sortie (pour l'UI)
    in_rms = 0.0               # niveau d'entrée micro (pour l'UI)

S = State()
LOCK = threading.Lock()


def log(msg):
    print(f"IA:{msg}", flush=True)


# ----------------------------------------------------------------------
#  Découverte des modèles
# ----------------------------------------------------------------------
def find_models():
    """Retourne [{name, pth, index}] à partir des sous-dossiers de MODELS_DIR."""
    out = []
    if not MODELS_DIR.exists():
        return out
    for sub in sorted(MODELS_DIR.iterdir()):
        if not sub.is_dir() or sub.name.startswith("_") or sub.name.startswith("."):
            continue
        pth = next((f for f in sub.glob("*.pth")), None)
        idx = next((f for f in sub.glob("*.index")), None)
        if pth:
            out.append({"name": sub.name, "pth": str(pth), "index": str(idx) if idx else None})
    # modèles à plat (pth directement dans MODELS_DIR)
    for pth in MODELS_DIR.glob("*.pth"):
        idx = next((MODELS_DIR.glob(pth.stem + "*.index")), None)
        out.append({"name": pth.stem, "pth": str(pth), "index": str(idx) if idx else None})
    return out


def load_model(name):
    models = {m["name"]: m for m in find_models()}
    if name not in models:
        raise ValueError(f"Modèle introuvable : {name}")
    m = models[name]
    log(f"Chargement du modèle « {name} » sur {DEVICE}...")
    rvc = RVCInference(device=DEVICE)
    # load_model(model_path_or_name, version='v2', index_path='')
    rvc.load_model(m["pth"], index_path=m["index"] or "")
    rvc.set_params(f0up_key=S.f0up_key, index_rate=S.index_rate,
                   f0method=S.f0method, protect=S.protect)
    S.rvc = rvc
    S.model_name = name
    # SR de sortie réel du modèle (exposé par le VC interne)
    try:
        S.target_sr = int(rvc.vc.tgt_sr)
    except Exception:
        S.target_sr = 40000
    log(f"Modèle chargé (SR cible {S.target_sr}).")


# ----------------------------------------------------------------------
#  Endpoints fichier
# ----------------------------------------------------------------------
@app.get("/health")
def health():
    gpu = None
    try:
        gpu = torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
    except Exception:
        pass
    return {
        "ok": True,
        "cuda": torch.cuda.is_available(),
        "gpu": gpu,
        "model": S.model_name,
        "live": S.live,
        "models_dir": str(MODELS_DIR),
        "last_error": S.last_error,
    }


@app.get("/models")
def models():
    return {"models": [m["name"] for m in find_models()], "current": S.model_name}


@app.post("/select")
def select(body: dict = Body(...)):
    name = body.get("name")
    try:
        with LOCK:
            load_model(name)
        return {"ok": True, "model": S.model_name}
    except Exception as e:
        S.last_error = str(e)
        return JSONResponse({"ok": False, "error": str(e)}, status_code=400)


@app.post("/params")
def params(body: dict = Body(...)):
    for k in ("f0up_key", "index_rate", "f0method", "protect",
              "live_index_rate", "live_f0method"):
        if k in body and body[k] is not None:
            setattr(S, k, body[k])
    if S.rvc is not None:
        try:
            S.rvc.set_params(f0up_key=S.f0up_key, index_rate=S.index_rate,
                             f0method=S.f0method, protect=S.protect)
        except Exception:
            pass
    return {"ok": True, "f0up_key": S.f0up_key, "index_rate": S.index_rate,
            "f0method": S.f0method, "protect": S.protect}


@app.post("/convert")
def convert(body: dict = Body(...)):
    """Reçoit {audio_b64, name?} WAV -> renvoie {audio_b64} WAV converti."""
    try:
        if body.get("name") and body["name"] != S.model_name:
            with LOCK:
                load_model(body["name"])
        if S.rvc is None:
            return JSONResponse({"ok": False, "error": "Aucun modèle chargé"}, status_code=400)

        raw = base64.b64decode(body["audio_b64"])
        tmp_in = Path(__file__).parent / "_tmp_in.wav"
        tmp_out = Path(__file__).parent / "_tmp_out.wav"
        tmp_in.write_bytes(raw)
        with LOCK:
            S.rvc.infer_file(str(tmp_in), str(tmp_out))
        data = tmp_out.read_bytes()
        return {"ok": True, "audio_b64": base64.b64encode(data).decode()}
    except Exception as e:
        S.last_error = str(e)
        traceback.print_exc()
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


# ----------------------------------------------------------------------
#  Conversion temps réel
# ----------------------------------------------------------------------
def list_devices():
    outs, ins = [], []
    try:
        for i, d in enumerate(sd.query_devices()):
            entry = {"index": i, "name": d["name"], "hostapi": d["hostapi"],
                     "max_in": d["max_input_channels"], "max_out": d["max_output_channels"]}
            if d["max_output_channels"] > 0:
                outs.append(entry)
            if d["max_input_channels"] > 0:
                ins.append(entry)
    except Exception as e:
        S.last_error = str(e)
    return ins, outs


@app.get("/devices")
def devices():
    ins, outs = list_devices()
    return {"inputs": ins, "outputs": outs}


def find_device(name_substr, want_output=True):
    """
    Trouve l'index d'un périphérique par nom (ex. 'CABLE Input').
    Tolérant : certains hôtes Windows (MME) tronquent les noms à ~31 caractères,
    donc on accepte aussi « nom du périphérique contenu dans le nom cherché ».
    On privilégie MME (hostapi 0) : rééchantillonnage universel, le plus fiable.
    """
    ins, outs = list_devices()
    pool = outs if want_output else ins
    q = name_substr.lower().strip()
    for d in sorted(pool, key=lambda d: d["hostapi"]):
        dn = d["name"].lower().strip()
        if q in dn or (len(dn) >= 10 and dn in q):
            return d["index"]
    return None


class RingBuffer:
    """
    Tampon audio circulaire thread-safe. Le thread de conversion y DÉPOSE
    l'audio converti (par à-coups), les callbacks de sortie y PUISENT à un
    rythme régulier. C'est ce tampon qui absorbe l'irrégularité du GPU et
    supprime les craquements/grésillements des jointures de blocs.
    """
    def __init__(self, capacity):
        self.buf = np.zeros(capacity, dtype=np.float32)
        self.cap = capacity
        self.w = 0          # position d'écriture
        self.avail = 0      # échantillons disponibles à lire
        self.lock = threading.Lock()

    def write(self, data):
        with self.lock:
            n = len(data)
            if n > self.cap:            # bloc plus grand que le tampon : garde la fin
                data = data[-self.cap:]; n = self.cap
            end = self.w + n
            if end <= self.cap:
                self.buf[self.w:end] = data
            else:                       # enroulement
                k = self.cap - self.w
                self.buf[self.w:] = data[:k]
                self.buf[:end - self.cap] = data[k:]
            self.w = end % self.cap
            self.avail = min(self.cap, self.avail + n)

    def read(self, n):
        """Renvoie n échantillons ; complète avec du silence si pas assez (underrun doux)."""
        out = np.zeros(n, dtype=np.float32)
        with self.lock:
            m = min(n, self.avail)
            if m > 0:
                r = (self.w - self.avail) % self.cap   # position de lecture
                end = r + m
                if end <= self.cap:
                    out[:m] = self.buf[r:end]
                else:
                    k = self.cap - r
                    out[:k] = self.buf[r:]
                    out[k:m] = self.buf[:end - self.cap]
                self.avail -= m
        return out


def live_loop(in_dev, out_dev, block_sec, crossfade_sec, extra_sec, mon_dev="off"):
    """
    Conversion temps réel avec tampon anti-grésillement.

    Architecture : le thread principal lit le micro, convertit par blocs, et
    DÉPOSE le résultat dans des ring buffers. Deux flux de sortie (câble + casque)
    tournent en mode CALLBACK et PUISENT dans ces tampons à cadence régulière.
    Le découplage production (irrégulière) / lecture (régulière) élimine les
    underruns qui causaient les craquements.
    """
    mic_sr = 16000  # RVC travaille en 16k en entrée (HuBERT)
    out_sr = S.target_sr

    block = int(block_sec * mic_sr)
    extra = int(extra_sec * mic_sr)
    xf = int(crossfade_sec * out_sr)

    # tampons de sortie : ~1,5 s de marge (absorbe les à-coups du GPU)
    cap = int(out_sr * 1.5)
    ring_out = RingBuffer(cap)
    ring_mon = RingBuffer(cap)

    import queue
    q_in = queue.Queue()

    def in_cb(indata, frames, time_info, status):
        mono = indata[:, 0].copy()
        S.in_rms = float(np.sqrt(np.mean(mono ** 2)))
        q_in.put(mono)

    # IMPORTANT : un callback qui lève une exception fait couper le flux par
    # sounddevice, SANS erreur visible. On protège donc tout et on remplit
    # toujours outdata (silence par défaut).
    def out_cb(outdata, frames, time_info, status):
        try:
            outdata[:, 0] = ring_out.read(frames)
        except Exception:
            outdata.fill(0)

    def mon_cb(outdata, frames, time_info, status):
        try:
            if S.monitor_on:
                outdata[:, 0] = ring_mon.read(frames) * float(S.monitor_vol)
            else:
                ring_mon.read(frames)   # vide quand même le tampon (garde la sync)
                outdata.fill(0)
        except Exception:
            outdata.fill(0)

    in_buffer = np.zeros(0, dtype=np.float32)
    prev_tail = np.zeros(xf, dtype=np.float32) if xf > 0 else np.zeros(0, dtype=np.float32)

    mon_stream = None
    # crée le retour casque sauf s'il pointe sur le MÊME périphérique que la
    # sortie principale (dans ce cas la sortie principale suffit déjà).
    if mon_dev != "off" and mon_dev != out_dev:
        try:
            mon_stream = sd.OutputStream(samplerate=out_sr, channels=1, device=mon_dev,
                                         dtype="float32", callback=mon_cb)
            mon_stream.start()
            log("Retour casque ouvert.")
        except Exception as e:
            S.last_error = f"moniteur: {e}"
            log(f"Retour casque indisponible : {e}")
            mon_stream = None

    try:
        out_stream = sd.OutputStream(samplerate=out_sr, channels=1, device=out_dev,
                                     dtype="float32", callback=out_cb)
        in_stream = sd.InputStream(samplerate=mic_sr, channels=1, device=in_dev,
                                   dtype="float32", blocksize=block, callback=in_cb)
        out_stream.start(); in_stream.start()
        try:
            log("LIVE_ON")
            infer_fails = 0
            first_block = True
            while not S.live_stop.is_set():
                try:
                    chunk = q_in.get(timeout=0.5)
                except queue.Empty:
                    continue
                in_buffer = np.concatenate([in_buffer, chunk])
                if len(in_buffer) < block + 2 * extra:
                    continue
                seg = in_buffer[: block + 2 * extra]
                in_buffer = in_buffer[block:]  # avance d'un bloc

                try:
                    with LOCK:
                        if S.rvc is None:
                            continue
                        out = infer_block(seg)
                except Exception as e:
                    S.last_error = f"live infer: {e}"
                    infer_fails += 1
                    if infer_fails == 1 or infer_fails % 20 == 0:
                        log(f"ERREUR conversion ({infer_fails}x) : {e}")
                    continue

                out = np.asarray(out, dtype=np.float32).flatten()
                # RVC sort à l'échelle int16 (±32768) -> normalise en [-1, 1]
                if len(out) and float(np.max(np.abs(out))) > 2.0:
                    out = out / 32768.0
                np.clip(out, -1.0, 1.0, out=out)
                if first_block and len(out):
                    first_block = False
                    log("Premier bloc converti et envoyé — la voix IA est opérationnelle.")

                # retire le contexte de part et d'autre
                ratio = out_sr / mic_sr
                cut = int(extra * ratio)
                core = out[cut: len(out) - cut] if cut > 0 and len(out) > 2 * cut else out

                # crossfade Hann avec la queue du bloc précédent (jointures lisses)
                if xf > 0 and len(core) > xf and len(prev_tail) == xf:
                    fade = np.hanning(2 * xf)[:xf].astype(np.float32)
                    core[:xf] = core[:xf] * fade + prev_tail * (1.0 - fade)
                    prev_tail = core[-xf:].copy()
                    body = core[:-xf]
                else:
                    body = core

                if len(body):
                    S.rms = float(np.sqrt(np.mean(body ** 2)))
                    ring_out.write(body)
                    if mon_stream is not None:
                        ring_mon.write(body)
            log("LIVE_OFF")
        finally:
            in_stream.stop(); in_stream.close()
            out_stream.stop(); out_stream.close()
    except Exception as e:
        S.last_error = str(e)
        traceback.print_exc()
        log("LIVE_ERROR")
    finally:
        if mon_stream is not None:
            try:
                mon_stream.stop(); mon_stream.close()
            except Exception:
                pass
        S.live = False


def infer_block(seg16k):
    """
    Convertit un bloc audio numpy (mono, 16 kHz, float32) en la voix cible,
    en appelant directement le pipeline RVC (aucune écriture disque).
    Retourne un numpy int16/float à S.target_sr.
    """
    vc = S.rvc.vc
    # charge HuBERT à la première inférence
    if getattr(vc, "hubert_model", None) is None:
        from rvc_python.modules.vc.utils import load_hubert
        vc.hubert_model = load_hubert(vc.config, vc.lib_dir)

    audio = np.asarray(seg16k, dtype=np.float32)
    amax = np.abs(audio).max() / 0.95
    if amax > 1:
        audio = audio / amax

    # En live : index réduit (rapide) et méthode f0 dédiée pour tenir le temps réel
    idx_rate = S.live_index_rate
    file_index = ""
    if idx_rate > 0:
        model_info = S.rvc.models[S.rvc.current_model]
        file_index = (model_info.get("index", "") or "").strip(' "\n').replace("trained", "added")

    times = [0, 0, 0]
    out = vc.pipeline.pipeline(
        vc.hubert_model, vc.net_g, 0, audio, "live",
        times, int(S.f0up_key), S.live_f0method, file_index, idx_rate,
        vc.if_f0, S.filter_radius, vc.tgt_sr, 0, S.rms_mix_rate,
        vc.version, S.protect, "",
    )
    return np.asarray(out, dtype=np.float32)


@app.post("/live/start")
def live_start(body: dict = Body(...)):
    if S.live:
        return {"ok": True, "already": True}
    if S.rvc is None:
        name = body.get("name")
        if not name:
            return JSONResponse({"ok": False, "error": "Aucun modèle chargé"}, status_code=400)
        try:
            with LOCK:
                load_model(name)
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=400)

    # périphériques : sortie = câble virtuel, ou sortie par défaut si absent (mode test)
    out_name = body.get("output_device")
    in_name = body.get("input_device")  # None -> micro par défaut
    out_dev = None
    if isinstance(out_name, str) and out_name:
        out_dev = find_device(out_name, want_output=True)
        if out_dev is None:
            return JSONResponse({"ok": False, "error": f"Périphérique de sortie introuvable : {out_name}"}, status_code=400)
    elif isinstance(out_name, int):
        out_dev = out_name
    in_dev = find_device(in_name, want_output=False) if isinstance(in_name, str) and in_name else None

    # retour casque : "off" si non demandé ; None = sortie par défaut ; sinon résolu par nom
    mon_dev = "off"
    if "monitor_device" in body:
        mn = body.get("monitor_device")
        if isinstance(mn, str) and mn:
            mon_dev = find_device(mn, want_output=True)  # introuvable -> None = défaut
        else:
            mon_dev = None
    S.monitor_on = bool(body.get("monitor", False))
    try:
        S.monitor_vol = max(0.0, min(2.0, float(body.get("monitor_vol", S.monitor_vol))))
    except Exception:
        pass

    block_sec = float(body.get("block_sec", 0.35))
    crossfade_sec = float(body.get("crossfade_sec", 0.06))
    extra_sec = float(body.get("extra_sec", 0.08))
    if body.get("f0up_key") is not None:
        S.f0up_key = int(body["f0up_key"])
    if body.get("live_index_rate") is not None:
        S.live_index_rate = float(body["live_index_rate"])

    # précharge HuBERT pour que le 1er bloc ne soit pas lent
    try:
        with LOCK:
            vc = S.rvc.vc
            if getattr(vc, "hubert_model", None) is None:
                from rvc_python.modules.vc.utils import load_hubert
                vc.hubert_model = load_hubert(vc.config, vc.lib_dir)
    except Exception as e:
        log(f"préchargement HuBERT: {e}")

    # préchauffe complète du GPU : la toute 1re inférence CUDA coûte 3-5 s
    # (compilation des kernels). On la paye ICI, pas pendant le direct.
    try:
        log("Préchauffage du moteur (quelques secondes)...")
        with LOCK:
            warm = np.zeros(int((block_sec + 2 * extra_sec) * 16000), dtype=np.float32)
            infer_block(warm)
        log("Moteur préchauffé, GPU prêt.")
    except Exception as e:
        log(f"préchauffage: {e}")

    S.input_device, S.output_device = in_dev, out_dev

    # journalise les périphériques réellement utilisés (diagnostic pour l'utilisateur)
    try:
        din = sd.query_devices(in_dev if in_dev is not None else sd.default.device[0])["name"]
        dout = sd.query_devices(out_dev if out_dev is not None else sd.default.device[1])["name"]
        log(f"Micro (entrée) : {din}")
        log(f"Sortie : {dout}")
        if "cable" in din.lower():
            log("ATTENTION : l'entrée est le câble virtuel, pas ton micro ! "
                "Choisis ton vrai micro dans « Mon micro -> Discord » (réglages).")
        if mon_dev != "off":
            mname = sd.query_devices(mon_dev if mon_dev is not None else sd.default.device[1])["name"]
            log(f"Retour casque : {mname} ({'actif' if S.monitor_on else 'coupé'})")
    except Exception:
        pass

    S.live_stop.clear()
    S.live = True
    S.live_thread = threading.Thread(
        target=live_loop, args=(in_dev, out_dev, block_sec, crossfade_sec, extra_sec, mon_dev),
        daemon=True)
    S.live_thread.start()
    return {"ok": True, "output_device": out_dev, "input_device": in_dev,
            "monitor": S.monitor_on}


@app.post("/live/monitor")
def live_monitor(body: dict = Body(...)):
    """Active/coupe le retour casque pendant le live, sans le redémarrer."""
    if body.get("on") is not None:
        S.monitor_on = bool(body["on"])
    if body.get("volume") is not None:
        try:
            S.monitor_vol = max(0.0, min(2.0, float(body["volume"])))
        except Exception:
            pass
    return {"ok": True, "on": S.monitor_on, "volume": S.monitor_vol}


@app.post("/live/stop")
def live_stop():
    S.live_stop.set()
    S.live = False
    return {"ok": True}


@app.get("/live/level")
def live_level():
    return {"live": S.live, "rms": S.rms, "in_rms": S.in_rms}


if __name__ == "__main__":
    log(f"Démarrage backend Voix IA — device={DEVICE}, port={PORT}")
    log(f"Dossier modèles : {MODELS_DIR}")
    log("READY")  # signal pour Electron
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
