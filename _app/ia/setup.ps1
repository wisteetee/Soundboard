# =====================================================================
#  Installation du backend Voix IA (RVC) - cree un venv Python 3.10
#  et installe PyTorch CUDA + rvc-python + dependances.
#
#  NOTE: fichier volontairement en ASCII pur (sans accents) pour etre
#  compatible avec Windows PowerShell 5.1 quelle que soit la page de code.
#
#  Usage : powershell -ExecutionPolicy Bypass -File setup.ps1
#  Progression emise sur stdout avec le prefixe "SETUP:" (lu par Electron).
# =====================================================================
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$venv = Join-Path $here ".venv310"
$py310 = $null

function Say($msg) { Write-Output "SETUP:$msg" }

Say "Recherche de Python 3.10..."

# 1) Cherche un Python 3.10 deja present
try {
  $probe = & py -3.10 -c "import sys;print(sys.executable)" 2>$null
  if ($LASTEXITCODE -eq 0 -and $probe) { $py310 = "$probe".Trim() }
} catch {}

if (-not $py310) {
  foreach ($cand in @(
    "$env:LOCALAPPDATA\Programs\Python\Python310\python.exe",
    "C:\Python310\python.exe"
  )) {
    if (Test-Path $cand) { $py310 = $cand; break }
  }
}

# 2) Installe Python 3.10 via winget si absent
if (-not $py310) {
  Say "Python 3.10 absent - installation via winget (1-2 min)..."
  winget install -e --id Python.Python.3.10 --silent --accept-source-agreements --accept-package-agreements
  Start-Sleep -Seconds 3
  foreach ($cand in @(
    "$env:LOCALAPPDATA\Programs\Python\Python310\python.exe",
    "C:\Python310\python.exe"
  )) {
    if (Test-Path $cand) { $py310 = $cand; break }
  }
  if (-not $py310) {
    try {
      $probe = & py -3.10 -c "import sys;print(sys.executable)" 2>$null
      if ($LASTEXITCODE -eq 0 -and $probe) { $py310 = "$probe".Trim() }
    } catch {}
  }
}

if (-not $py310) { Say "ERREUR: impossible de trouver ou installer Python 3.10."; exit 1 }
Say "Python 3.10 : $py310"

# 3) Cree le venv
if (-not (Test-Path (Join-Path $venv "Scripts\python.exe"))) {
  Say "Creation de l'environnement virtuel..."
  & $py310 -m venv $venv
}
$vpy = Join-Path $venv "Scripts\python.exe"
if (-not (Test-Path $vpy)) { Say "ERREUR: echec de creation du venv."; exit 1 }

# 4) pip : version FIGEE a 23.3.2
#    (pip >= 24.1 refuse omegaconf==2.0.6, dependance de rvc-python)
Say "Installation de pip 23.3.2 (requis pour rvc-python)..."
& $vpy -m pip install "pip==23.3.2" --quiet
if ($LASTEXITCODE -ne 0) { Say "ERREUR: echec installation pip."; exit 1 }

# 5) PyTorch CUDA 11.8 (gros telechargement ~2.5 Go, ou cache pip si deja fait)
Say "Installation de PyTorch CUDA (~2.5 Go, patiente)..."
& $vpy -m pip install torch==2.1.1+cu118 torchaudio==2.1.1+cu118 --index-url https://download.pytorch.org/whl/cu118
if ($LASTEXITCODE -ne 0) { Say "ERREUR: echec installation PyTorch."; exit 1 }

# 6) Le reste des dependances
Say "Installation de rvc-python et dependances..."
& $vpy -m pip install -r (Join-Path $here "requirements.txt")
if ($LASTEXITCODE -ne 0) { Say "ERREUR: echec installation des dependances."; exit 1 }

# 7) Verif GPU
Say "Verification du GPU..."
$cuda = & $vpy -c "import torch;print('CUDA' if torch.cuda.is_available() else 'CPU')" 2>$null
Say "Backend pret. Calcul : $cuda"
Say "DONE"
