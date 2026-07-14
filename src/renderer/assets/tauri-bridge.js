// Tauri-Bruecke: baut window.nutridesk mit denselben Funktionen nach wie frueher die Electron-preload.js.
// Laeuft NUR unter Tauri (window.__TAURI__ vorhanden). Unter Electron/Browser passiert nichts,
// dann bleibt die dortige window.nutridesk (Electron) bzw. gar keine (Browser) bestehen.
(function () {
  var T = window.__TAURI__;
  if (!T || !T.core || typeof T.core.invoke !== 'function') return;
  var invoke = T.core.invoke;
  var listen = (T.event && T.event.listen) ? T.event.listen : null;

  window.nutridesk = {
    getVersion: function () { return invoke('app_version'); },
    notify: function (items) {
      return invoke('notify_items', { items: Array.isArray(items) ? items : [] })
        .then(function (shown) { return { ok: true, shown: shown }; })
        .catch(function () { return { ok: false }; });
    },
    getAutostart: function () { return invoke('autostart_get'); },
    setAutostart: function (on) {
      return invoke('autostart_set', { on: !!on })
        .then(function (openAtLogin) { return { ok: true, openAtLogin: openAtLogin }; })
        .catch(function () { return { ok: false }; });
    },
    checkForUpdates: function () { return invoke('upd_check'); },
    installUpdate: function () { return invoke('upd_install'); },
    getChannel: function () { return invoke('upd_get_channel'); },
    setChannel: function (ch) { return invoke('upd_set_channel', { ch: ch }); },
    onUpdate: function (cb) { if (listen) { listen('upd', function (e) { cb(e.payload); }); } },
  };
})();
