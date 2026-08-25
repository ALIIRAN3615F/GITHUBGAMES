// All DOM-side interface: menus, meters, prompts, chat and the results table.
// Nothing here touches game state directly - main.js pushes values in, and the
// HUD raises callbacks back out.

const $ = (id) => document.getElementById(id);

const STATE_NAME = ['alive', 'down', 'dead', 'escaped'];

export class Hud {
  constructor() {
    this.el = {
      screens: $('screens'),
      hud: $('hud'),
      title: $('screenTitle'),
      lobby: $('screenLobby'),
      end: $('screenEnd'),
      pause: $('screenPause'),
      click: $('screenClick'),
      loading: $('loading'),

      objText: $('objText'),
      fusePips: $('fusePips'),
      staminaFill: $('staminaFill'),
      batteryFill: $('batteryFill'),
      carrying: $('carrying'),
      roster: $('roster'),
      pingVal: $('pingVal'),
      chatLog: $('chatLog'),
      chatInputWrap: $('chatInputWrap'),
      chatInput: $('chatInput'),
      prompt: $('prompt'),
      promptKey: $('promptKey'),
      promptText: $('promptText'),
      promptFill: $('promptFill'),
      crosshair: $('crosshair'),
      banner: $('statusBanner'),
      downed: $('downedOverlay'),
      downTimer: $('downTimer'),
      dead: $('deadOverlay'),
      scoreboard: $('scoreboard'),

      nameInput: $('nameInput'),
      joinBtn: $('joinBtn'),
      connError: $('connError'),
      lanUrl: $('lanUrl'),
      lobbyPlayers: $('lobbyPlayers'),
      lobbyCount: $('lobbyCount'),
      startBtn: $('startBtn'),
      readyBtn: $('readyBtn'),
      hostNote: $('hostNote'),
      setFuses: $('setFuses'),
      fuseVal: $('fuseVal'),
      endTitle: $('endTitle'),
      endSummary: $('endSummary'),
      endTable: $('endTable'),
      endCountdown: $('endCountdown'),
    };

    this.chatLines = [];
    this.bannerTimer = 0;
    this.callbacks = {};
    this.el.lanUrl.textContent = location.origin;
    this.bindMenus();
  }

  on(name, fn) { this.callbacks[name] = fn; return this; }
  fire(name, ...args) { if (this.callbacks[name]) this.callbacks[name](...args); }

  // --- Screens --------------------------------------------------------------

  showScreen(name) {
    for (const key of ['title', 'lobby', 'end', 'pause', 'click']) {
      this.el[key].classList.toggle('active', key === name);
    }
    this.current = name || null;
  }

  setHudVisible(visible) { this.el.hud.hidden = !visible; }
  setLoading(visible, text) {
    this.el.loading.hidden = !visible;
    if (text) $('loadingText').textContent = text;
  }

  // --- Menu wiring ----------------------------------------------------------

  bindMenus() {
    const saved = localStorage.getItem('signal-lost:name');
    if (saved) this.el.nameInput.value = saved;

    this.el.joinBtn.addEventListener('click', () => {
      const name = this.el.nameInput.value.trim() || 'Survivor';
      localStorage.setItem('signal-lost:name', name);
      this.el.joinBtn.disabled = true;
      this.el.joinBtn.textContent = 'OPENING THE HATCH...';
      this.fire('join', name);
    });
    this.el.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.el.joinBtn.click();
    });

    this.el.startBtn.addEventListener('click', () => this.fire('start'));
    this.el.readyBtn.addEventListener('click', () => this.fire('ready'));
    this.el.click.addEventListener('click', () => this.fire('requestLock'));
    $('resumeBtn').addEventListener('click', () => this.fire('resume'));
    $('leaveBtn').addEventListener('click', () => this.fire('leave'));

    for (const [id, key] of [['setDifficulty', 'difficulty'], ['setSize', 'size'], ['setQuality', 'quality']]) {
      const group = $(id);
      group.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn || btn.disabled) return;
        for (const b of group.querySelectorAll('button')) b.classList.toggle('on', b === btn);
        this.fire(key, btn.dataset.v);
      });
    }

    this.el.setFuses.addEventListener('input', (e) => {
      this.el.fuseVal.textContent = e.target.value;
      this.fire('fuses', parseInt(e.target.value, 10));
    });

    for (const [id, labelId, key, fmt] of [
      ['setSens', 'sensVal', 'sensitivity', (v) => (v / 100).toFixed(1)],
      ['setVol', 'volVal', 'volume', (v) => String(v)],
      ['setFov', 'fovVal', 'fov', (v) => String(v)],
    ]) {
      const input = $(id);
      input.addEventListener('input', (e) => {
        const v = parseInt(e.target.value, 10);
        $(labelId).textContent = fmt(v);
        this.fire(key, v);
      });
    }

    this.el.chatInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const text = this.el.chatInput.value.trim();
        this.closeChat();
        if (text) this.fire('chat', text);
      } else if (e.key === 'Escape') {
        this.closeChat();
      }
    });
  }

  setJoinError(message) {
    this.el.connError.hidden = !message;
    this.el.connError.textContent = message || '';
    this.el.joinBtn.disabled = false;
    this.el.joinBtn.textContent = 'ENTER THE FACILITY';
  }

  applySettings(settings) {
    $('setSens').value = Math.round(settings.sensitivity * 100);
    $('sensVal').textContent = settings.sensitivity.toFixed(1);
    $('setVol').value = Math.round(settings.volume * 100);
    $('volVal').textContent = String(Math.round(settings.volume * 100));
    $('setFov').value = settings.fov;
    $('fovVal').textContent = String(settings.fov);
    for (const b of $('setQuality').querySelectorAll('button')) {
      b.classList.toggle('on', b.dataset.v === settings.quality);
    }
  }

  // --- Lobby ----------------------------------------------------------------

  renderLobby(data, localId) {
    const isHost = data.host === localId;
    this.el.lobbyCount.textContent = `${data.players.length}/8`;
    this.el.lobbyPlayers.innerHTML = '';

    for (const p of data.players) {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = '#' + p.color.toString(16).padStart(6, '0');
      const name = document.createElement('span');
      name.textContent = p.name + (p.id === localId ? ' (you)' : '');
      const tag = document.createElement('span');
      tag.className = 'tag' + (p.id === data.host ? ' host' : p.ready ? ' ready' : '');
      tag.textContent = p.id === data.host ? 'HOST' : p.ready ? 'READY' : '';
      li.append(dot, name, tag);
      this.el.lobbyPlayers.appendChild(li);
    }

    // Only the host may change the run; everyone else sees the settings locked.
    for (const id of ['setDifficulty', 'setSize']) {
      for (const b of $(id).querySelectorAll('button')) b.disabled = !isHost;
    }
    this.el.setFuses.disabled = !isHost;
    this.el.startBtn.disabled = !isHost;
    this.el.hostNote.textContent = isHost
      ? 'You are the host. Everyone drops in when you start.'
      : 'Waiting on the host to start the run.';

    if (data.cfg) {
      for (const [id, value] of [['setDifficulty', data.cfg.difficulty], ['setSize', data.cfg.size]]) {
        for (const b of $(id).querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === value);
      }
      this.el.setFuses.value = data.cfg.fuses;
      this.el.fuseVal.textContent = String(data.cfg.fuses);
    }

    const me = data.players.find((p) => p.id === localId);
    this.el.readyBtn.classList.toggle('on', !!(me && me.ready));
    this.el.readyBtn.textContent = me && me.ready ? 'READY' : 'READY UP';
  }

  // --- In-game --------------------------------------------------------------

  // Every setter below is called from the frame loop, so each one skips the
  // DOM write when the value has not actually changed. Layout and style
  // recalculation was costing more than the rendering on weak machines.
  setMeters(stamina, battery) {
    const s = Math.round(Math.max(0, stamina));
    const b = Math.round(Math.max(0, battery));
    if (s !== this.lastStamina) {
      this.lastStamina = s;
      this.el.staminaFill.style.transform = `scaleX(${s / 100})`;
      this.el.staminaFill.classList.toggle('low', s < 25);
    }
    if (b !== this.lastBattery) {
      this.lastBattery = b;
      this.el.batteryFill.style.transform = `scaleX(${b / 100})`;
      this.el.batteryFill.classList.toggle('low', b < 20);
    }
  }

  setObjective(text, urgent = false) {
    if (this.el.objText.textContent !== text) this.el.objText.textContent = text;
    this.el.objText.classList.toggle('urgent', urgent);
  }

  setFusePips(powered, need) {
    if (this.pipCount !== need) {
      this.pipCount = need;
      this.el.fusePips.innerHTML = '';
      for (let i = 0; i < need; i++) this.el.fusePips.appendChild(document.createElement('i'));
    }
    const pips = this.el.fusePips.children;
    for (let i = 0; i < pips.length; i++) pips[i].classList.toggle('on', i < powered);
  }

  setCarrying(carrying) {
    if (carrying === this.lastCarrying) return;
    this.lastCarrying = carrying;
    this.el.carrying.hidden = !carrying;
  }

  setPing(ms) {
    if (ms === this.lastPing) return;
    this.lastPing = ms;
    this.el.pingVal.textContent = String(ms);
  }

  updateRoster(players, localId) {
    // Rebuilding this markup every frame reparsed HTML 60 times a second for
    // a panel that changes a few times a round.
    const signature = players.map((p) => `${p.id}:${p.state}:${p.carrying ? 1 : 0}:${p.downTimer}`).join('|');
    if (signature === this.lastRoster) return;
    this.lastRoster = signature;

    const rows = players.map((p) => {
      const cls = 'roster-row ' + STATE_NAME[p.state];
      const you = p.id === localId ? ' *' : '';
      const carry = p.carrying ? ' <span class="carry">[F]</span>' : '';
      const label = p.state === 1 ? ` ${p.downTimer}s` : p.state === 3 ? ' OUT' : '';
      const color = '#' + p.color.toString(16).padStart(6, '0');
      return `<div class="${cls}"><span>${escapeHtml(p.name)}${you}${label}</span>${carry}` +
        `<span class="dot" style="background:${color}"></span></div>`;
    });
    this.el.roster.innerHTML = rows.join('');
  }

  showPrompt(key, text, progress = 0) {
    this.el.prompt.hidden = false;
    if (this.el.promptKey.textContent !== key) this.el.promptKey.textContent = key;
    if (this.el.promptText.textContent !== text) this.el.promptText.textContent = text;
    this.el.promptFill.style.width = `${Math.round(progress * 100)}%`;
    this.el.crosshair.classList.add('active');
  }

  hidePrompt() {
    this.el.prompt.hidden = true;
    this.el.crosshair.classList.remove('active');
  }

  banner(text, kind = '', duration = 3.2) {
    this.el.banner.hidden = false;
    this.el.banner.textContent = text;
    this.el.banner.className = kind;
    this.bannerTimer = duration;
  }

  setDowned(down, seconds) {
    this.el.downed.hidden = !down;
    if (down) this.el.downTimer.textContent = String(Math.max(0, seconds));
  }

  setDead(dead) { this.el.dead.hidden = !dead; }

  tick(dt) {
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.el.banner.hidden = true;
    }
  }

  // --- Chat -----------------------------------------------------------------

  addChat(from, text, color) {
    const div = document.createElement('div');
    const c = color ? '#' + color.toString(16).padStart(6, '0') : '#8a97a3';
    div.innerHTML = `<span class="who" style="color:${c}">${escapeHtml(from)}</span> ${escapeHtml(text)}`;
    this.pushChat(div);
  }

  addSystem(text) {
    const div = document.createElement('div');
    div.className = 'sys';
    div.textContent = text;
    this.pushChat(div);
  }

  pushChat(node) {
    this.el.chatLog.appendChild(node);
    this.chatLines.push(node);
    // Keep the log short: it sits over the play area and must not become a wall.
    while (this.chatLines.length > 7) {
      const old = this.chatLines.shift();
      old.remove();
    }
    // Fade the oldest lines out so recent traffic reads first.
    this.chatLines.forEach((n, i) => {
      n.style.opacity = String(0.35 + (i / this.chatLines.length) * 0.65);
    });
  }

  openChat() {
    this.el.chatInputWrap.hidden = false;
    this.el.chatInput.value = '';
    this.el.chatInput.focus();
    this.chatOpen = true;
  }

  closeChat() {
    this.el.chatInputWrap.hidden = true;
    this.el.chatInput.blur();
    this.chatOpen = false;
    this.fire('chatClosed');
  }

  // --- Scoreboard & results -------------------------------------------------

  toggleScoreboard(show, players, powered, need, time) {
    this.el.scoreboard.hidden = !show;
    if (!show) return;
    const rows = players.map((p) => {
      const fate = STATE_NAME[p.state];
      return `<tr><td style="color:#${p.color.toString(16).padStart(6, '0')}">${escapeHtml(p.name)}</td>` +
        `<td>${fate}</td><td>${p.fuses ?? 0} fuses</td><td>${p.revives ?? 0} saves</td></tr>`;
    }).join('');
    this.el.scoreboard.innerHTML =
      `<h3>SITUATION &mdash; ${powered}/${need} POWERED &mdash; ${formatTime(time)}</h3><table>${rows}</table>`;
  }

  renderEnd(data) {
    const won = data.outcome === 'escaped';
    this.el.endTitle.textContent = won ? 'EXTRACTED' : 'NO SURVIVORS';
    this.el.endTitle.className = 'screen-heading ' + (won ? 'won' : 'lost');
    const escapedCount = data.players.filter((p) => p.escaped).length;
    this.el.endSummary.innerHTML =
      `${data.powered} of ${data.need} fuses seated &middot; ${formatTime(data.time)} underground<br>` +
      (won
        ? `${escapedCount} of ${data.players.length} made it to the surface.`
        : 'The facility kept everyone. It usually does.');

    this.el.endTable.innerHTML = data.players.map((p) => {
      const fate = p.escaped ? 'escaped' : p.state === 2 ? 'lost' : 'left behind';
      const cls = p.escaped ? 'fate-escaped' : 'fate-dead';
      return `<tr><td style="color:#${p.color.toString(16).padStart(6, '0')}">${escapeHtml(p.name)}</td>` +
        `<td class="${cls}">${fate}</td><td>${p.fuses} fuses</td><td>${p.revives} saves</td>` +
        `<td>${p.downs} downs</td></tr>`;
    }).join('');
  }

  setEndCountdown(seconds) { this.el.endCountdown.textContent = String(Math.max(0, seconds)); }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
