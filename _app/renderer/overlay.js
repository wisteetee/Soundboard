'use strict';
/*
 * Overlay in-game : mini fenêtre toujours au premier plan avec les favoris.
 * Même origine file:// que la fenêtre principale -> on lit son localStorage
 * (favoris, icônes, compteurs). La lecture est relayée à la fenêtre
 * principale pour que volumes, stats et réglages s'appliquent normalement.
 */

function readState() {
  try { return JSON.parse(localStorage.getItem('sb-state') || '{}'); }
  catch { return {}; }
}

async function render() {
  const grid = document.getElementById('grid');
  const st = readState();
  const icons = st.icons || {};
  const favs = st.favs || [];
  const plays = st.plays || {};

  const all = (await window.sb.listSounds()) || [];
  const byFile = new Map(all.map(s => [s.file, s]));

  // favoris d'abord ; sinon les 12 sons les plus joués
  let files = favs.filter(f => byFile.has(f));
  if (!files.length) {
    files = all
      .slice()
      .sort((a, b) => (plays[b.file] || 0) - (plays[a.file] || 0))
      .slice(0, 12)
      .map(s => s.file);
  }

  grid.innerHTML = '';
  if (!files.length) {
    grid.innerHTML = '<div class="empty">Aucun son.<br>Ajoute des ⭐ favoris dans le soundboard !</div>';
    return;
  }
  for (const f of files) {
    const s = byFile.get(f);
    const ic = icons[f] || {};
    const el = document.createElement('div');
    el.className = 't';
    el.title = s.name;
    const ico = document.createElement('div');
    ico.className = 'ico';
    if (ic.image) {
      const img = document.createElement('img');
      img.src = window.sb.iconUrl(ic.image);
      ico.appendChild(img);
    } else {
      ico.textContent = ic.emoji || '🔊';
      if (typeof ic.color === 'number') ico.style.background = `hsl(${ic.color} 45% 28%)`;
    }
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = s.name;
    el.append(ico, nm);
    el.addEventListener('click', () => window.sb.overlay.play(f));
    grid.appendChild(el);
  }
}

document.getElementById('refresh').addEventListener('click', render);
document.getElementById('stop').addEventListener('click', () => window.sb.overlay.stop());
document.getElementById('close').addEventListener('click', () => window.sb.overlay.close());
window.sb.onOverlayRefresh(render);
render();
