// Kleine Browser-Bruecke fuer Web-Funktionen, ganz ohne Tauri/Electron.
(function () {
  window.nutridesk = {
    getVersion: function () { return Promise.resolve('Web'); },
    bioKind: function () { return Promise.resolve('none'); },
    bioAuth: function () {
      return Promise.resolve({ ok: false, error: 'Biometrie ist im Browser nicht verfügbar.' });
    },
    notify: async function (items) {
      if (!('Notification' in window)) return { ok: false, shown: 0 };
      var permission = Notification.permission;
      if (permission === 'default') permission = await Notification.requestPermission();
      if (permission !== 'granted') return { ok: false, shown: 0 };
      var list = Array.isArray(items) ? items : [];
      list.forEach(function (item) {
        new Notification(String(item.title || 'NutriDesk'), {
          body: String(item.body || ''),
          icon: 'assets/icon.png'
        });
      });
      return { ok: true, shown: list.length };
    }
  };
})();
