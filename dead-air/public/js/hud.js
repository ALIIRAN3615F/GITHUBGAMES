// Menus, meters, chat and results.
//
// Every setter compares before it writes. The HUD is the only DOM in the frame
// loop, and a layout triggered sixty times a second for a number that has not
// changed is the cheapest frame-rate problem there is to avoid.

const $ = (id) => document.getElementById(id);
const STATE_NAME = ['alive', 'down', 'dead', 'out'];

export class Hud {
  constructor() {
    this.el = {
      hud: $('hud'),
      screens: {
        title: $('screenTitle'), lobby: $('screenLobby'),
        pause: $('screenPause'), end: $('screenEnd'),
      },
      loading: $('loading'),
      nameInput: $('nameInput'), joinBtn: $('joinBtn'), joinError: $('joinError'),
      lobbyPlayers: $('lobbyPlayers'), hostSettings: $('hostSettings'),
      sizeChoices: $('sizeChoices'), diffChoices: $('diffChoices'),
      setFuses: $('setFuses'), fuseVal: $('fuseVal'),
      readyBtn: $('readyBtn'), startBtn: $('startBtn'),
      leaveLobbyBtn: $('leaveLobbyBtn'), leaveBtn: $('leaveBtn'), resumeBtn: $('resumeBtn'),
      setVol: $('setVol'), volVal: $('volVal'), setZoom: $('setZoom'), zoomVal: $('zoomVal'),
      objText: $('objText'), fusePips: $('fusePips'),
      staminaFill: $('staminaFill'), batteryFill: $('batteryFill'),
      chargeVal: $('chargeVal'), reserveVal: $('reserveVal'), carrying: $('carrying'),
      roster: $('roster'), pingVal: $('pingVal'),
      prompt: $('prompt'), promptKey: $('promptKey'), promptText: $('promptText'), promptFill: $('promptFill'),
      banner: $('banner'), downed: $('downed'), downTimer: $('downTimer'), dead: $('dead'),
      chatLog: $('chatLog'), chatForm: $('chatForm'), chatInput: $('chatInput'),
      scoreboard: $('scoreboard'),
      endTitle: $('endTitle'), endSummary: $('endSummary'), endTable: $('endTable'),
      endCountdown: $('endCountdown'),
      flash: $('flash'),
    };
    this.callbacks = {};
    this.current = 'title';
    this.chatOpen = false;
    this.bannerTimer = 0;
    this.flashTimer = 0;
    this.bindMenus();
  }

  on(name, fn) { this.callbacks[name] = fn; return this; }
  fire(name, ...args) { if (this.callbacks[name]) this.callbacks[name](...args); }

  showScreen(name) {
    for (const [key, el] of Object.entries(this.el.screens)) el.classList.toggle('active', key === name);
    this.current = name || null;
  }

  setHudVisible(v) { this.el.hud.hidden = !v; }
  setLoading(v, text) {
    this.el.loading.hidden = !v;
    if (text) $('loadingText').textContent = text;
  }

  bindMenus() {
    this.el.joinBtn.addEventListener('click', () => this.fire('join', this.el.nameInput.value.trim()));
    this.el.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.fire('join', this.el.nameInput.value.trim());
    });
    this.el.readyBtn.addEventListener('click', () => this.fire('ready'));
    this.el.startBtn.addEventListener('click', () => this.fire('start'));
    this.el.leaveLobbyBtn.addEventListener('click', () => this.fire('leave'));
    this.el.leaveBtn.addEventListener('click', () => this.fire('leave'));
    this.el.resumeBtn.addEventListener('click', () => this.fire('resume'));

    for (const [key, label] of [['small', 'SMALL'], ['medium', 'MEDIUM'], ['large', 'LARGE']]) {
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = label;
      b.dataset.size = key;
      b.addEventListener('click', () => this.fire('config', { size: key }));
      this.el.sizeChoices.appendChild(b);
    }

    this.el.setFuses.addEventListener('input', () => {
      this.el.fuseVal.textContent = this.el.setFuses.value;
      this.fire('config', { fuses: +this.el.setFuses.value });
    });
    this.el.setVol.addEventListener('input', () => {
      this.el.volVal.textContent = this.el.setVol.value;
      this.fire('setting', { volume: +this.el.setVol.value / 100 });
    });
    this.el.setZoom.addEventListener('input', () => {
      this.el.zoomVal.textContent = (+this.el.setZoom.value / 100).toFixed(1);
      this.fire('setting', { zoom: +this.el.setZoom.value / 100 });
    });

    this.el.chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = this.el.chatInput.value.trim();
      if (text) this.fire('chat', text);
      this.closeChat();
    });
  }

  buildDifficulties(map) {
    if (this.el.diffChoices.childElementCount) return;
    for (const [key, label] of Object.entries(map)) {
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = String(label).toUpperCase();
      b.dataset.diff = key;
      b.addEventListener('click', () => this.fire('config', { difficulty: key }));
      this.el.diffChoices.appendChild(b);
    }
  }

  setJoinError(message) { this.el.joinError.textContent = message || ''; }

  applySettings(s) {
    this.el.setVol.value = Math.round(s.volume * 100);
    this.el.volVal.textContent = this.el.setVol.value;
    this.el.setZoom.value = Math.round(s.zoom * 100);
    this.el.zoomVal.textContent = s.zoom.toFixed(1);
    if (s.name) this.el.nameInput.value = s.name;
  }

  // --- Lobby -------------------------------------------------------------------

  renderLobby(data, localId) {
    this.el.lobbyPlayers.innerHTML = '';
    for (const p of data.players) {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = '#' + p.color.toString(16).padStart(6, '0');
      const name = document.createElement('span');
      name.textContent = p.name + (p.id === localId ? ' (you)' : '');
      const tag = document.createElement('span');
      tag.className = 'tag' + (p.ready ? ' ready' : '');
      tag.textContent = p.id === data.host ? 'HOST' : p.ready ? 'READY' : '';
      li.append(dot, name, tag);
      this.el.lobbyPlayers.appendChild(li);
    }

    const isHost = data.host === localId;
    this.el.hostSettings.style.opacity = isHost ? '1' : '0.4';
    this.el.hostSettings.style.pointerEvents = isHost ? 'auto' : 'none';
    this.el.startBtn.disabled = !isHost;
    this.el.setFuses.value = data.cfg.fuses;
    this.el.fuseVal.textContent = data.cfg.fuses;
    for (const b of this.el.sizeChoices.children) b.classList.toggle('on', b.dataset.size === data.cfg.size);
    for (const b of this.el.diffChoices.children) b.classList.toggle('on', b.dataset.diff === data.cfg.difficulty);
  }

  // --- In game -----------------------------------------------------------------

  setMeters(stamina, charge) {
    const s = Math.round(stamina), c = Math.round(charge);
    if (this._stamina !== s) { this._stamina = s; this.el.staminaFill.style.width = s + '%'; }
    if (this._charge !== c) {
      this._charge = c;
      this.el.batteryFill.style.width = c + '%';
      this.el.chargeVal.textContent = c + '%';
    }
  }

  setReserve(n) {
    if (this._reserve === n) return;
    this._reserve = n;
    this.el.reserveVal.textContent = String(n);
  }

  setObjective(text, urgent = false) {
    if (this._objective !== text) { this._objective = text; this.el.objText.textContent = text; }
    if (this._urgent !== urgent) { this._urgent = urgent; this.el.objText.classList.toggle('urgent', urgent); }
  }

  setFusePips(powered, need) {
    if (this._pipCount !== need) {
      this._pipCount = need;
      this.el.fusePips.innerHTML = '';
      for (let i = 0; i < need; i++) this.el.fusePips.appendChild(document.createElement('i'));
    }
    const pips = this.el.fusePips.children;
    for (let i = 0; i < pips.length; i++) pips[i].classList.toggle('on', i < powered);
  }

  setCarrying(on) {
    if (this._carrying === on) return;
    this._carrying = on;
    this.el.carrying.hidden = !on;
  }

  setPing(ms) {
    const v = Math.round(ms);
    if (this._ping === v) return;
    this._ping = v;
    this.el.pingVal.textContent = String(v);
  }

  updateRoster(players, localId) {
    const key = players.map((p) => `${p.id}:${p.state}:${p.carrying ? 1 : 0}`).join('|');
    if (this._rosterKey === key) return;
    this._rosterKey = key;
    this.el.roster.innerHTML = '';
    for (const p of players) {
      const row = document.createElement('div');
      row.className = STATE_NAME[p.state] || '';
      const colour = '#' + p.color.toString(16).padStart(6, '0');
      row.innerHTML = `<span style="color:${colour}">${escapeHtml(p.name)}</span>` +
        (p.id === localId ? ' <span style="opacity:.5">you</span>' : '') +
        (p.carrying ? ' <span style="color:#ffc24a">fuse</span>' : '') +
        (p.state === 1 ? ` <span>${p.downTimer}s</span>` : '');
      this.el.roster.appendChild(row);
    }
  }

  showPrompt(key, text, progress = 0) {
    this.el.prompt.hidden = false;
    if (this.el.promptKey.textContent !== key) this.el.promptKey.textContent = key;
    if (this.el.promptText.textContent !== text) this.el.promptText.textContent = text;
    this.el.promptFill.style.width = Math.round(progress * 100) + '%';
  }

  hidePrompt() { this.el.prompt.hidden = true; }

  banner(text, kind = '', duration = 3.2) {
    this.el.banner.hidden = false;
    this.el.banner.textContent = text;
    this.el.banner.className = kind;
    this.bannerTimer = duration;
  }

  // A red pulse over the whole screen, for the moment something reaches you.
  flash(strength = 0.6, seconds = 0.5) {
    this.el.flash.style.opacity = String(strength);
    this.flashTimer = seconds;
  }

  setDowned(down, seconds) {
    this.el.downed.hidden = !down;
    if (down) this.el.downTimer.textContent = String(Math.max(0, Math.ceil(seconds || 0)));
  }

  setDead(dead) { this.el.dead.hidden = !dead; }

  tick(dt) {
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.el.banner.hidden = true;
    }
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) this.el.flash.style.opacity = '0';
    }
  }

  // --- Chat --------------------------------------------------------------------

  addChat(from, text, colour) {
    const div = document.createElement('div');
    div.innerHTML = `<span style="color:${colour}">${escapeHtml(from)}</span> ${escapeHtml(text)}`;
    this.pushChat(div);
  }

  addSystem(text) {
    const div = document.createElement('div');
    div.className = 'system';
    div.textContent = text;
    this.pushChat(div);
  }

  pushChat(node) {
    this.el.chatLog.appendChild(node);
    while (this.el.chatLog.childElementCount > 7) this.el.chatLog.removeChild(this.el.chatLog.firstChild);
  }

  openChat() {
    this.chatOpen = true;
    this.el.chatForm.hidden = false;
    this.el.chatInput.value = '';
    this.el.chatInput.focus();
  }

  closeChat() {
    this.chatOpen = false;
    this.el.chatForm.hidden = true;
    this.el.chatInput.blur();
    this.fire('chatClosed');
  }

  // --- Scoreboard and results ----------------------------------------------------

  toggleScoreboard(show, players, powered, need, time) {
    this.el.scoreboard.hidden = !show;
    if (!show) return;
    this.el.scoreboard.innerHTML =
      `<div style="letter-spacing:.3em;color:#6f7a84">${powered} / ${need} FUSES &middot; ${formatTime(time)}</div>` +
      '<table>' + players.map((p) => {
        const colour = '#' + p.color.toString(16).padStart(6, '0');
        return `<tr><td style="color:${colour}">${escapeHtml(p.name)}</td>` +
          `<td>${STATE_NAME[p.state] || ''}</td><td>${p.carrying ? 'carrying' : ''}</td></tr>`;
      }).join('') + '</table>';
  }

  renderEnd(data) {
    const ending = ENDINGS[data.outcome] || ENDINGS.lost;
    const out = data.players.filter((p) => p.escaped).length;
    this.el.endTitle.textContent = ending.title;
    this.el.endTitle.className = 'heading ' + ending.tone;
    this.el.endSummary.innerHTML =
      `${data.powered} of ${data.need} fuses seated &middot; ${formatTime(data.time)} underground<br>` +
      ending.body(out, data.players.length);
    this.el.endTable.innerHTML = data.players.map((p) => {
      const fate = p.escaped ? 'got out' : p.state === 2 ? 'lost' : 'left behind';
      const cls = p.escaped ? 'fate-out' : 'fate-lost';
      return `<tr><td style="color:#${p.color.toString(16).padStart(6, '0')}">${escapeHtml(p.name)}</td>` +
        `<td class="${cls}">${fate}</td><td>${p.fuses} fuses</td>` +
        `<td>${p.revives} saves</td><td>${p.downs} downs</td></tr>`;
    }).join('');
  }

  setEndCountdown(s) { this.el.endCountdown.textContent = String(Math.max(0, s)); }
}

const ENDINGS = {
  escaped: {
    title: 'OUT',
    tone: 'won',
    body: (out, total) =>
      `${out} of ${total} made it to the surface.<br>` +
      'The facility is still humming behind you. Whatever was down there is still down there.',
  },
  lost: {
    title: 'NO SURVIVORS',
    tone: 'lost',
    body: () => 'The facility kept everyone. It usually does.',
  },
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60), s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
